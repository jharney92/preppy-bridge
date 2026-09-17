// ====================================================================
// backfill_preppy_people.mjs
//
// One-off backfill: create Attio People for StraighterLine/Preppy
// contacts that are enrolled in an allowlisted Apollo sequence but have
// no Attio record. The bridge can only write engagement onto existing
// People, so these contacts' opens/clicks/replies were being dropped.
//
// Scope: StraighterLine ONLY. The script refuses to run unless
// GET /v2/self reports workspace_slug "straighter-line", and it only
// considers contacts whose Apollo sequence membership intersects
// config.PREPPY_SEQUENCE_IDS.
//
//   node backfill_preppy_people.mjs            # dry run -> backfill_plan.json
//   node backfill_preppy_people.mjs --confirm  # create -> backfill_created.json
//
// Creates use the same dedupe-safe assert the bridge uses
// (PUT /objects/people/records?matching_attribute=email_addresses), so a
// record that appeared between planning and writing is updated, not
// duplicated. Every created record is stamped
// source_batch_id = BATCH_ID, which rollback_backfill.mjs keys on.
//
// Deliberately NOT written: engagement counters, outreach stage,
// outbound status, sequence status. Those belong to real events.
// `company` is a record-reference to Companies in this workspace, so the
// Apollo organisation name cannot go there and is left unset.
// ====================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREPPY_SEQUENCE_IDS } = require('./config.js');

export const BATCH_ID = 'preppy_apollo_backfill_20260917';

const CONFIRM = process.argv.includes('--confirm');
const ATTIO_BASE = 'https://api.attio.com/v2';
const APOLLO_BASE = 'https://api.apollo.io/v1';

// Politeness delay between write calls (ms).
const WRITE_DELAY_MS = 350;
const READ_DELAY_MS = 150;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- credentials -----------------------------------------------------

function loadEnvLocal() {
  // .env.local comes from `vercel env pull` and is gitignored.
  const out = {};
  let raw;
  try { raw = readFileSync(new URL('./.env.local', import.meta.url), 'utf8'); }
  catch { return out; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const envFile = loadEnvLocal();
const ATTIO_API_KEY = process.env.ATTIO_API_KEY || envFile.ATTIO_API_KEY;
// The production Apollo key is not readable locally; use the Keychain one.
const APOLLO_API_KEY =
  process.env.APOLLO_API_KEY ||
  execFileSync('security', ['find-generic-password', '-s', 'apollo-new-workspace-key', '-w'])
    .toString()
    .trim();

if (!ATTIO_API_KEY) throw new Error('ATTIO_API_KEY not available (run `vercel env pull .env.local`)');
if (!APOLLO_API_KEY) throw new Error('Apollo key not available from Keychain');

// --- http ------------------------------------------------------------

async function api(url, opts = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    // Back off on rate limits and transient server errors; fail fast on 4xx.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status} ${url} — ${text.slice(0, 400)}`);
  }
}

const attioHeaders = {
  Authorization: `Bearer ${ATTIO_API_KEY}`,
  'Content-Type': 'application/json',
};
const apolloHeaders = {
  'X-Api-Key': APOLLO_API_KEY,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
};

// --- hard scope guard ------------------------------------------------

async function assertStraighterLine() {
  const self = await api(`${ATTIO_BASE}/self`, { headers: attioHeaders });
  const slug = self?.workspace_slug;
  if (slug !== 'straighter-line') {
    throw new Error(`REFUSING TO RUN: Attio workspace is "${slug}", expected "straighter-line"`);
  }
  console.log(`Attio workspace confirmed: ${self.workspace_name} (${slug})`);
}

// --- Apollo ----------------------------------------------------------

async function contactsInSequence(sequenceId) {
  const contacts = [];
  let page = 1;
  for (;;) {
    const res = await api(`${APOLLO_BASE}/contacts/search`, {
      method: 'POST',
      headers: apolloHeaders,
      body: JSON.stringify({
        emailer_campaign_ids: [sequenceId],
        page,
        per_page: 100,
      }),
    });
    const batch = res?.contacts || [];
    contacts.push(...batch);
    const totalPages = res?.pagination?.total_pages || 1;
    if (page >= totalPages || batch.length === 0) break;
    page += 1;
    await sleep(READ_DELAY_MS);
  }
  return contacts;
}

// --- Attio -----------------------------------------------------------

async function attioPersonByEmail(email) {
  const res = await api(`${ATTIO_BASE}/objects/people/records/query`, {
    method: 'POST',
    headers: attioHeaders,
    body: JSON.stringify({
      filter: { email_addresses: { email_address: { $eq: email } } },
      limit: 1,
    }),
  });
  return res?.data?.[0] || null;
}

async function upsertPerson(values) {
  const res = await api(
    `${ATTIO_BASE}/objects/people/records?matching_attribute=email_addresses`,
    { method: 'PUT', headers: attioHeaders, body: JSON.stringify({ data: { values } }) }
  );
  return res?.data?.id?.record_id;
}

// --- plan ------------------------------------------------------------

function buildValues(entry) {
  const first = entry.first_name || '';
  const last = entry.last_name || '';
  const full = entry.name || [first, last].filter(Boolean).join(' ');
  const values = {
    email_addresses: [{ email_address: entry.email }],
    source_batch_id: BATCH_ID,
  };
  if (full || first || last) {
    values.name = [{
      first_name: first || full.split(/\s+/)[0] || '',
      last_name: last || full.split(/\s+/).slice(1).join(' ') || '',
      full_name: full,
    }];
  }
  if (entry.title) values.job_title = entry.title;
  if (entry.apollo_contact_id) values.apollo_contact_id = String(entry.apollo_contact_id);
  if (entry.assigned_sequence) values.assigned_sequence = entry.assigned_sequence;
  // `company` intentionally omitted — record-reference to Companies, and
  // the Apollo organisation name is not a valid value for that type.
  return values;
}

async function main() {
  await assertStraighterLine();

  const nameById = Object.fromEntries(
    Object.entries(PREPPY_SEQUENCE_IDS).map(([name, id]) => [id, name])
  );

  // 1. Gather every contact enrolled in an allowlisted Preppy sequence.
  const byEmail = new Map();
  for (const [seqName, seqId] of Object.entries(PREPPY_SEQUENCE_IDS)) {
    const contacts = await contactsInSequence(seqId);
    console.log(`  ${contacts.length.toString().padStart(4)}  ${seqName}`);
    for (const c of contacts) {
      const email = (c.email || '').toLowerCase().trim();
      if (!email) continue;
      // First sequence wins for Assigned Sequence; the set of all matched
      // sequences is recorded so a multi-enrolled contact is visible in the plan.
      const seqIds = (c.emailer_campaign_ids || []).filter(id => nameById[id]);
      const existing = byEmail.get(email);
      if (existing) {
        existing.all_preppy_sequences = [
          ...new Set([...existing.all_preppy_sequences, ...seqIds.map(id => nameById[id])]),
        ];
        continue;
      }
      byEmail.set(email, {
        email,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        name: c.name || null,
        title: c.title || null,
        company: c.organization_name || c.account?.name || null, // reported, NOT written
        apollo_contact_id: c.id || null,
        assigned_sequence: nameById[seqIds[0]] || seqName,
        all_preppy_sequences: seqIds.map(id => nameById[id]),
      });
    }
  }
  console.log(`\nUnique enrolled contacts across allowlisted sequences: ${byEmail.size}`);

  // 2. Drop the ones Attio already has.
  const plan = [];
  const alreadyInAttio = [];
  for (const entry of byEmail.values()) {
    const existing = await attioPersonByEmail(entry.email);
    if (existing) {
      alreadyInAttio.push({ email: entry.email, record_id: existing.id?.record_id });
    } else {
      plan.push({ ...entry, values: buildValues(entry) });
    }
    await sleep(READ_DELAY_MS);
  }

  const planFile = new URL('./backfill_plan.json', import.meta.url);
  writeFileSync(planFile, JSON.stringify({
    batch_id: BATCH_ID,
    generated_at: new Date().toISOString(),
    counts: {
      enrolled_unique: byEmail.size,
      already_in_attio: alreadyInAttio.length,
      to_create: plan.length,
    },
    already_in_attio: alreadyInAttio,
    plan,
  }, null, 2));

  console.log(`\nenrolled_unique   : ${byEmail.size}`);
  console.log(`already_in_attio  : ${alreadyInAttio.length}`);
  console.log(`to_create         : ${plan.length}`);
  console.log(`plan written      : backfill_plan.json`);

  if (!CONFIRM) {
    console.log('\nDRY RUN — nothing written to Attio. Re-run with --confirm to create.');
    return;
  }

  // 3. Create.
  const created = [];
  const failed = [];
  for (const [i, entry] of plan.entries()) {
    try {
      const recordId = await upsertPerson(entry.values);
      created.push({ email: entry.email, record_id: recordId, apollo_contact_id: entry.apollo_contact_id });
      console.log(`  [${i + 1}/${plan.length}] ${entry.email} -> ${recordId}`);
    } catch (err) {
      failed.push({ email: entry.email, error: err.message });
      console.error(`  [${i + 1}/${plan.length}] FAILED ${entry.email}: ${err.message}`);
    }
    // Log incrementally so an interrupted run is still fully rollback-able.
    writeFileSync(
      new URL('./backfill_created.json', import.meta.url),
      JSON.stringify({ batch_id: BATCH_ID, created, failed }, null, 2)
    );
    await sleep(WRITE_DELAY_MS);
  }

  console.log(`\ncreated: ${created.length}  failed: ${failed.length}`);
  console.log('ids logged to backfill_created.json');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
