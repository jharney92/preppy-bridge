// ====================================================================
// lib/attio.js — Attio REST API helpers
//
// Docs: https://developers.attio.com/reference
//
// Notes:
// - All Attio attribute writes use the "values" wrapper format.
// - For Select attributes, write the option NAME as a string (Attio resolves it).
// - For Timestamp, use ISO 8601 string.
// - The "vercel-bridge" API key needs Records R/W, List Entries R/W,
//   List Configuration R, Notes R/W (already configured in Phase 1.6).
// ====================================================================

const { request } = require('./http');

const ATTIO_BASE = 'https://api.attio.com/v2';

function authHeaders() {
  const key = process.env.ATTIO_API_KEY;
  if (!key) throw new Error('ATTIO_API_KEY not set');
  return { Authorization: `Bearer ${key}` };
}

// --- People ---

async function findPersonByEmail(email) {
  const res = await request(`${ATTIO_BASE}/objects/people/records/query`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      filter: { email_addresses: { email_address: { '$eq': email } } },
      limit: 1,
    },
  });
  return res?.data?.[0] || null;
}

/**
 * Build the value for Attio's `name` (personal-name) attribute. Attio
 * wants first/last/full together; a missing part is derived from what
 * is present rather than left blank.
 */
function personalName({ firstName, lastName, fullName }) {
  const first = (firstName || '').trim();
  const last = (lastName || '').trim();
  const full = (fullName || '').trim() || [first, last].filter(Boolean).join(' ');
  if (!first && !last && !full) return null;
  return [{
    first_name: first || full.split(/\s+/)[0] || '',
    last_name: last || full.split(/\s+/).slice(1).join(' ') || '',
    full_name: full,
  }];
}

/**
 * Dedupe-safe create-or-update of a People record, keyed on email.
 *
 * Uses Attio's assert endpoint (`PUT .../records?matching_attribute=
 * email_addresses`), the same call Cortex's push uses: if a record with
 * that email already exists, Attio updates it in place instead of
 * creating a duplicate. Returns { recordId, values }.
 *
 * `company` is deliberately NOT accepted: in this workspace it is a
 * record-reference to Companies, so a company NAME cannot be written
 * there. Writing the org name as text would need a different attribute.
 */
async function upsertPersonByEmail({
  email,
  firstName,
  lastName,
  fullName,
  jobTitle,
  apolloContactId,
  assignedSequence,
  sourceBatchId,
} = {}) {
  if (!email) throw new Error('upsertPersonByEmail requires an email');

  const values = { email_addresses: [{ email_address: email }] };
  const name = personalName({ firstName, lastName, fullName });
  if (name) values.name = name;
  if (jobTitle) values.job_title = jobTitle;
  if (apolloContactId) values.apollo_contact_id = String(apolloContactId);
  if (assignedSequence) values.assigned_sequence = assignedSequence;
  if (sourceBatchId) values.source_batch_id = sourceBatchId;

  const res = await request(
    `${ATTIO_BASE}/objects/people/records?matching_attribute=email_addresses`,
    {
      method: 'PUT',
      headers: authHeaders(),
      body: { data: { values } },
    }
  );
  const recordId = res?.data?.id?.record_id;
  if (!recordId) throw new Error(`Attio person upsert returned no record_id: ${JSON.stringify(res).slice(0, 300)}`);
  return { recordId, values: res?.data?.values || {}, record: res?.data || null };
}

/**
 * Find every People record carrying a given source_batch_id. Used by the
 * backfill rollback script to scope deletion to exactly what it created.
 */
async function findPeopleBySourceBatchId(batchId) {
  const all = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await request(`${ATTIO_BASE}/objects/people/records/query`, {
      method: 'POST',
      headers: authHeaders(),
      body: { filter: { source_batch_id: { '$eq': batchId } }, limit, offset },
    });
    const page = res?.data || [];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

async function deletePerson(personId) {
  return request(`${ATTIO_BASE}/objects/people/records/${personId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
}

async function getPersonById(personId) {
  const res = await request(`${ATTIO_BASE}/objects/people/records/${personId}`, {
    headers: authHeaders(),
  });
  return res?.data || null;
}

async function updatePersonAttributes(personId, attributes) {
  // attributes is { attr_slug: value, ... }
  const values = {};
  for (const [k, v] of Object.entries(attributes)) {
        // Select attributes use { option } with the option TITLE as a bare
        // string — [{ option: { title: ... } }] returns 400. All other
        // types use { value }.
          const SELECT_ATTRS = ['outreach_stage', 'last_engagement_type', 'apollo_sequence_status', 'outbound_status'];
          if (Array.isArray(v)) {
                    values[k] = v;
          } else if (SELECT_ATTRS.includes(k)) {
                    values[k] = [{ option: v }];
          } else {
                    values[k] = [{ value: v }];
          }
  }
  return request(`${ATTIO_BASE}/objects/people/records/${personId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: { data: { values } },
  });
}

/**
 * Convenience: write the engagement-related fields in one call.
 * Pass any subset; only provided fields are written.
 */
async function setEngagement(personId, {
  outreachStage,
  lastEngagementDate,
  lastEngagementType,
  apolloSequenceStatus,
  apolloContactId,
  assignedSequence,
  flaggedForReview,
  openCount7d,
  opensResetAt,
  outboundStatus,
  totalOpens,
  lastOpened,
  totalClicks,
  lastClicked,
  sequencesCompleted,
} = {}) {
  const attrs = {};
  if (outreachStage !== undefined)        attrs.outreach_stage         = outreachStage;
  if (lastEngagementDate !== undefined)   attrs.last_engagement_date   = lastEngagementDate;
  if (lastEngagementType !== undefined)   attrs.last_engagement_type   = lastEngagementType;
  if (apolloSequenceStatus !== undefined) attrs.apollo_sequence_status = apolloSequenceStatus;
  if (apolloContactId !== undefined)      attrs.apollo_contact_id      = apolloContactId;
  if (assignedSequence !== undefined)     attrs.assigned_sequence      = assignedSequence;
  if (flaggedForReview !== undefined)     attrs.flagged_for_review     = flaggedForReview;
  if (openCount7d !== undefined)          attrs.open_count_7d          = openCount7d;
  if (opensResetAt !== undefined)         attrs.opens_reset_at         = opensResetAt;
  if (outboundStatus !== undefined)       attrs.outbound_status        = outboundStatus;
  if (totalOpens !== undefined)           attrs.total_opens            = totalOpens;
  if (lastOpened !== undefined)           attrs.last_opened            = lastOpened;
  if (totalClicks !== undefined)          attrs.total_clicks           = totalClicks;
  if (lastClicked !== undefined)          attrs.last_clicked           = lastClicked;
  if (sequencesCompleted !== undefined)   attrs.sequences_completed    = sequencesCompleted;
  if (Object.keys(attrs).length === 0) return null;
  return updatePersonAttributes(personId, attrs);
}

// --- Notes ---

async function createNoteOnPerson(personId, { title, content }) {
  return request(`${ATTIO_BASE}/notes`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      data: {
        parent_object: 'people',
        parent_record_id: personId,
        title: title || 'Bridge note',
        format: 'plaintext',
        content: content || '',
      },
    },
  });
}

// --- Lists ---

async function findListIdByName(listName) {
  // List configuration: read scope. Cache in-process for warm invocations.
  if (!findListIdByName._cache) findListIdByName._cache = new Map();
  if (findListIdByName._cache.has(listName)) return findListIdByName._cache.get(listName);

  const res = await request(`${ATTIO_BASE}/lists`, { headers: authHeaders() });
  for (const list of res?.data || []) {
    findListIdByName._cache.set(list.name, list.id?.list_id || list.api_slug);
  }
  return findListIdByName._cache.get(listName) || null;
}

async function removePersonFromList(listName, personId) {
  const listId = await findListIdByName(listName);
  if (!listId) throw new Error(`Attio list not found: ${listName}`);
  // Find entries for this person on this list
  const entries = await request(
    `${ATTIO_BASE}/lists/${listId}/entries/query`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: {
        filter: { parent_record_id: { '$eq': personId } },
        limit: 10,
      },
    }
  );
  const results = [];
  for (const entry of entries?.data || []) {
    const entryId = entry?.id?.entry_id;
    if (!entryId) continue;
    const r = await request(
      `${ATTIO_BASE}/lists/${listId}/entries/${entryId}`,
      { method: 'DELETE', headers: authHeaders() }
    );
    results.push(r);
  }
  return results;
}

async function addPersonToList(listName, personId, entryValues = {}) {
  const listId = await findListIdByName(listName);
  if (!listId) throw new Error(`Attio list not found: ${listName}`);
  return request(`${ATTIO_BASE}/lists/${listId}/entries`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      data: {
        parent_record_id: personId,
        parent_object: 'people',
        entry_values: entryValues,
      },
    },
  });
}

// --- Search by Outreach Stage (used by dead-man's-switch) ---

async function findPeopleByStage(stages /* string[] */) {
  const all = [];
  let cursor = null;
  do {
    const body = {
      filter: { outreach_stage: { '$in': stages } },
      limit: 100,
    };
    if (cursor) body.cursor = cursor;
    const res = await request(`${ATTIO_BASE}/objects/people/records/query`, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });
    all.push(...(res?.data || []));
    cursor = res?.next_cursor || null;
  } while (cursor);
  return all;
}

async function getListEntries(listId, limit = 100) {
  const res = await request(
    `${ATTIO_BASE}/lists/${listId}/entries/query`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: { limit },
    }
  );
  return (res?.data || []).map(entry => ({
    entry_id: entry?.id?.entry_id,
    parent_record_id: entry?.parent_record_id || entry?.parent?.record_id,
    record_id: entry?.parent_record_id || entry?.parent?.record_id,
    values: entry?.entry_values || {},
  }));
}

module.exports = {
  findPersonByEmail,
  upsertPersonByEmail,
  findPeopleBySourceBatchId,
  deletePerson,
  getPersonById,
  updatePersonAttributes,
  setEngagement,
  createNoteOnPerson,
  findListIdByName,
  removePersonFromList,
  addPersonToList,
  findPeopleByStage,
  getListEntries,
};
