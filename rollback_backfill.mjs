// ====================================================================
// rollback_backfill.mjs
//
// Undo for backfill_preppy_people.mjs. Finds every Attio People record
// stamped source_batch_id = BATCH_ID and deletes it.
//
//   node rollback_backfill.mjs            # dry run — lists, deletes nothing
//   node rollback_backfill.mjs --confirm  # actually deletes
//   node rollback_backfill.mjs --batch-id <id> [--confirm]
//
// Safety:
// - Refuses to run unless GET /v2/self reports workspace_slug
//   "straighter-line".
// - Scoped strictly by source_batch_id. A record without that exact
//   stamp is never touched, so pre-existing People and the bridge's own
//   "bridge_autocreate" records are out of reach unless named explicitly.
// - Dry run is the default; deletion requires --confirm.
// ====================================================================

import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_BATCH_ID = 'preppy_apollo_backfill_20260917';
const ATTIO_BASE = 'https://api.attio.com/v2';
const DELETE_DELAY_MS = 250;

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const batchIdx = args.indexOf('--batch-id');
const BATCH_ID = batchIdx !== -1 ? args[batchIdx + 1] : DEFAULT_BATCH_ID;

if (!BATCH_ID) {
  console.error('--batch-id given with no value');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadEnvLocal() {
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

const ATTIO_API_KEY = process.env.ATTIO_API_KEY || loadEnvLocal().ATTIO_API_KEY;
if (!ATTIO_API_KEY) throw new Error('ATTIO_API_KEY not available (run `vercel env pull .env.local`)');

const headers = {
  Authorization: `Bearer ${ATTIO_API_KEY}`,
  'Content-Type': 'application/json',
};

async function api(url, opts = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status} ${url} — ${text.slice(0, 400)}`);
  }
}

async function assertStraighterLine() {
  const self = await api(`${ATTIO_BASE}/self`, { headers });
  if (self?.workspace_slug !== 'straighter-line') {
    throw new Error(`REFUSING TO RUN: Attio workspace is "${self?.workspace_slug}", expected "straighter-line"`);
  }
  console.log(`Attio workspace confirmed: ${self.workspace_name} (${self.workspace_slug})`);
}

async function findByBatchId(batchId) {
  const all = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await api(`${ATTIO_BASE}/objects/people/records/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: { source_batch_id: { $eq: batchId } },
        limit,
        offset,
      }),
    });
    const page = res?.data || [];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

function describe(record) {
  const v = record?.values || {};
  return {
    record_id: record?.id?.record_id,
    email: v.email_addresses?.[0]?.email_address || null,
    name: v.name?.[0]?.full_name || null,
    source_batch_id: v.source_batch_id?.[0]?.value || null,
  };
}

async function main() {
  await assertStraighterLine();
  console.log(`Scope: People with source_batch_id = "${BATCH_ID}"`);

  const records = (await findByBatchId(BATCH_ID)).map(describe);

  // Belt and braces: the query filter already scopes this, but re-check
  // each record's own stamp before deleting it.
  const targets = records.filter(r => r.source_batch_id === BATCH_ID && r.record_id);
  const mismatched = records.length - targets.length;

  console.log(`matched: ${records.length}  deletable: ${targets.length}` +
    (mismatched ? `  SKIPPED (stamp mismatch): ${mismatched}` : ''));
  for (const t of targets.slice(0, 10)) console.log(`  ${t.record_id}  ${t.email}`);
  if (targets.length > 10) console.log(`  … and ${targets.length - 10} more`);

  if (!CONFIRM) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --confirm to delete these records.');
    return;
  }

  const deleted = [];
  const failed = [];
  for (const [i, t] of targets.entries()) {
    try {
      await api(`${ATTIO_BASE}/objects/people/records/${t.record_id}`, { method: 'DELETE', headers });
      deleted.push(t);
      console.log(`  [${i + 1}/${targets.length}] deleted ${t.record_id} ${t.email}`);
    } catch (err) {
      failed.push({ ...t, error: err.message });
      console.error(`  [${i + 1}/${targets.length}] FAILED ${t.record_id}: ${err.message}`);
    }
    await sleep(DELETE_DELAY_MS);
  }

  writeFileSync(
    new URL('./backfill_rollback_log.json', import.meta.url),
    JSON.stringify({ batch_id: BATCH_ID, deleted_at: new Date().toISOString(), deleted, failed }, null, 2)
  );
  console.log(`\ndeleted: ${deleted.length}  failed: ${failed.length}  (log: backfill_rollback_log.json)`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
