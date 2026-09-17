// ====================================================================
// lib/apollo.js Ã¢ÂÂ Apollo.io REST API helpers
//
// Docs: https://docs.apollo.io/reference
//
// Notes from prior Outbound Flywheel work:
// - Apollo distinguishes Contact ID (the ID within YOUR workspace's CRM)
//   from Person ID (Apollo's global database ID). Sequence enrollment uses
//   CONTACT IDs. Confusing these is the #1 source of 422s.
// - Custom field writes use `typed_custom_fields` with the field IDs, not
//   the field names. Example:
//     { typed_custom_fields: { "<field_id>": "value" } }
// - The API key auth header is `X-Api-Key`, NOT Bearer.
// ====================================================================

const { request } = require('./http');
const { APOLLO_DEFAULT_MAILBOX_ID, APOLLO_SEND_USER_ID } = require('../config');

const APOLLO_BASE = 'https://api.apollo.io/v1';

function authHeaders() {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error('APOLLO_API_KEY not set');
  return {
    'X-Api-Key': key,
    'Cache-Control': 'no-cache',
  };
}

// --- Contacts ---

/**
 * Find or create a contact in Apollo by email. Returns the Apollo
 * CONTACT ID (not the global person_id).
 */
async function upsertContactByEmail({ email, firstName, lastName, title, organizationName, linkedinUrl }) {
  // 1. Try to find existing contact
  const search = await request(`${APOLLO_BASE}/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      q_keywords: email,
      page: 1,
      per_page: 5,
    },
  });
  const existing = (search?.contacts || []).find(c =>
    (c.email || '').toLowerCase() === email.toLowerCase()
  );
  if (existing) return { id: existing.id, created: false, contact: existing };

  // 2. Create
  const created = await request(`${APOLLO_BASE}/contacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      first_name: firstName,
      last_name: lastName,
      email,
      title,
      organization_name: organizationName,
      linkedin_url: linkedinUrl,
    },
  });
  const newContact = created?.contact;
  if (!newContact?.id) throw new Error(`Apollo contact create failed: ${JSON.stringify(created)}`);
  return { id: newContact.id, created: true, contact: newContact };
}

async function getContact(contactId) {
  const res = await request(`${APOLLO_BASE}/contacts/${contactId}`, {
    headers: authHeaders(),
  });
  return res?.contact || null;
}

/**
 * Update an Apollo contact. To write a custom field, pass it under
 * typed_custom_fields keyed by FIELD ID.
 */
async function updateContact(contactId, fields) {
  return request(`${APOLLO_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: fields,
  });
}

async function setContactStage(contactId, stageName) {
  // stageName must match an existing contact stage in your Apollo workspace.
  // Common stages: "Cold", "Warm", "Replied", "Do Not Contact", etc.
  return updateContact(contactId, { contact_stage_name: stageName });
}

// --- Sequences ---

async function addContactToSequence({ contactId, sequenceId, mailboxId, sendUserId }) {
  return request(`${APOLLO_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_id: sequenceId,
      send_email_from_email_account_id: mailboxId || APOLLO_DEFAULT_MAILBOX_ID,
      userId: sendUserId || APOLLO_SEND_USER_ID,
    },
  });
}

async function removeContactFromSequence({ contactId, sequenceId }) {
  return request(`${APOLLO_BASE}/emailer_campaigns/remove_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_ids: [sequenceId],
    },
  });
}

/**
 * Remove a contact from ALL sequences they're currently active in.
 * Used when a contact is marked Do Not Contact in Attio.
 */
async function removeContactFromAllSequences(contactId) {
  // Apollo's contact_sequence_states endpoint returns active sequences
  const res = await request(`${APOLLO_BASE}/contact_sequence_states/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_id: contactId, page: 1, per_page: 100 },
  });
  const states = res?.contact_sequence_states || [];
  const activeSequenceIds = states
    .filter(s => s.status === 'active' || s.is_active)
    .map(s => s.emailer_campaign_id || s.sequence_id)
    .filter(Boolean);
  if (activeSequenceIds.length === 0) return { removed: 0 };

  await request(`${APOLLO_BASE}/emailer_campaigns/remove_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_ids: activeSequenceIds,
    },
  });
  return { removed: activeSequenceIds.length, sequenceIds: activeSequenceIds };
}

/**
 * Check if a contact is currently active in any sequence.
 * Used by the dead-man's-switch.
 */
async function getActiveSequenceIds(contactId) {
  const res = await request(`${APOLLO_BASE}/contact_sequence_states/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_id: contactId, page: 1, per_page: 100 },
  });
  const states = res?.contact_sequence_states || [];
  return states
    .filter(s => s.status === 'active' || s.is_active)
    .map(s => s.emailer_campaign_id || s.sequence_id)
    .filter(Boolean);
}

// --- Lists ---
//
// Lists (a.k.a. "labels" in Apollo's older API) are the supported primitive
// for grouping contacts on plans where the sequence-enrollment API is gated.
// The bridge uses them for the drip re-engagement path: add a contact to
// the "Bridge Drip" list and an Apollo workflow picks it up and enrolls
// them in the drip sequence.

async function getContactLabels(contactId) {
  // GET /contacts/:id is gated (403), so use search to read labels.
  const res = await request(`${APOLLO_BASE}/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_ids: [contactId], per_page: 1 },
  });
  return res?.contacts?.[0]?.label_ids || [];
}

async function addContactToList(contactId, listId) {
  // read-merge-write: Apollo silently ignores add_label_ids,
  // so we search for current labels, merge, then SET with label_ids.
  const current = await getContactLabels(contactId);
  if (current.includes(listId)) return { already: true };
  return request(`${APOLLO_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: {
      label_ids: [...current, listId],
    },
  });
}

async function removeContactFromList(contactId, listId) {
  // read-merge-write: Apollo silently ignores remove_label_ids,
  // so we search for current labels, filter, then SET with label_ids.
  const current = await getContactLabels(contactId);
  if (!current.includes(listId)) return { already: true };
  return request(`${APOLLO_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: {
      label_ids: current.filter(id => id !== listId),
    },
  });
}

async function getContactsInList(listId, perPage = 100) {
  const res = await request(`${APOLLO_BASE}/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      label_ids: [listId],
      page: 1,
      per_page: perPage,
    },
  });
  return res?.contacts || [];
}

module.exports = {
  upsertContactByEmail,
  getContact,
  updateContact,
  setContactStage,
  addContactToSequence,
  removeContactFromSequence,
  removeContactFromAllSequences,
  getActiveSequenceIds,
  addContactToList,
  removeContactFromList,
  getContactsInList,
};
