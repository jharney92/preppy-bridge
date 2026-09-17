// ====================================================================
// api/apollo-webhook.js
//
// Handles all Apollo workflow webhook payloads:
//
//   1. "Preppy Flywheel: Email Replied → Webhook"      (event=replied)
//   2. "Preppy Flywheel: Email Bounced → Webhook"      (event=bounced)
//   3. "Preppy Flywheel: Contact Finished Sequence"    (event=finished)
//   4. "Preppy Flywheel: Email Opened → Webhook"       (event=opened)
//   5. "Preppy Flywheel: Email Clicked → Webhook"      (event=clicked)
//   6. "Preppy Flywheel: Meeting Booked → Webhook"     (event=meeting)
//   7. "Preppy Flywheel: Email Sent → Webhook"         (event=sent)
//
// SCOPE GUARD: NUKO's Apollo workspace also runs CLIMB and Invigilator
// outbound, and the workflow webhook body carries no sequence id. This
// endpoint writes ONLY into StraighterLine's Attio, so every request is
// resolved against Apollo and its real sequence membership checked
// against config.PREPPY_SEQUENCE_IDS before any Attio call. The check
// fails CLOSED — see sequenceGate() below.
//
// MISSING PEOPLE: the bridge can only write engagement onto an Attio
// record, and nothing has been creating StraighterLine People since
// 2026-08-06, so most events landed on no record at all. A gated contact
// with no Attio person is now created via a dedupe-safe upsert (assert on
// email_addresses) stamped source_batch_id = "bridge_autocreate", and the
// event's normal field writes then apply on top. The sequence allowlist
// still runs FIRST and still fails closed: a contact outside a Preppy
// sequence can never cause a create.
//
// Engagement threshold logic:
// - Clicks flag immediately (Flagged for Review = true).
// - Opens are counted on a rolling N-day window; once the count reaches
//   ENGAGEMENT_OPEN_THRESHOLD, Flagged for Review = true.
// - Replies/meetings flip Outreach Stage to Engaged/Meeting Booked.
// - Bounces set Outreach Stage = Do Not Contact.
// - Flagged contacts are NOT pulled out of their cold sequence; Apollo's
//   native auto-remove-on-reply handles the most important cutoff.
//
// Routing: the ?event= query param is required — the Apollo body carries
// no event name. An unrecognised event is a 400.
//
// Request contract (do not change without updating the Apollo workflows):
//   POST https://preppy-bridge.vercel.app/api/apollo-webhook
//        ?event=opened|clicked|replied|bounced|finished|meeting
//        &secret=<WEBHOOK_SHARED_SECRET>
//   body: {email, first_name, last_name, title, company, contact_id}
//         — or empty, which the handler tolerates.
// ====================================================================

const { ok, bad, fail, verifySecret } = require('../lib/respond');
const attio = require('../lib/attio');
const apollo = require('../lib/apollo');
const { shouldWriteOpenEvent, isDuplicateOpen, isDuplicateClick } = require('../lib/dedupe');
const { alert } = require('../lib/notify');
const {
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
  ENGAGEMENT_OPEN_THRESHOLD,
  ENGAGEMENT_OPEN_WINDOW_DAYS,
  PREPPY_SEQUENCE_IDS,
} = require('../config');

const VALID_EVENTS = new Set(['replied', 'opened', 'clicked', 'bounced', 'finished', 'meeting', 'sent']);

const PREPPY_IDS     = new Set(Object.values(PREPPY_SEQUENCE_IDS));

// Stamped on People the webhook creates itself, so autocreated records
// stay distinguishable from the manual import and from Cortex's pushes.
// Queryable: filter People on source_batch_id.
const AUTOCREATE_BATCH_ID = 'bridge_autocreate';

// Maps an Apollo sequence id to a name for the Attio "Assigned Sequence"
// text field.
const SEQUENCE_NAME_BY_ID = Object.fromEntries(
  Object.entries(PREPPY_SEQUENCE_IDS).map(([name, id]) => [id, name])
);

/**
 * Decide whether an event belongs to StraighterLine — the hard scope rule.
 *
 * Apollo's workflow webhook body carries NO sequence id (it is
 * {email, first_name, last_name, title, company, contact_id}, with the
 * event name in the query string), and the workflows' only enrolment
 * filter is prospected_by_current_team. The new Apollo workspace also
 * holds CLIMB and Invigilator sequences, so membership must be read back
 * from Apollo before anything is written to StraighterLine's Attio.
 *
 * FAILS CLOSED. Anything other than "this contact is demonstrably in a
 * Preppy sequence" results in no Attio write:
 *   - contact not resolvable in Apollo        -> skip
 *   - contact in zero sequences               -> skip
 *   - contact only in non-Preppy sequences    -> skip
 *   - Apollo lookup errors                    -> skip + alert
 */
async function sequenceGate(ctx) {
  let lookup;
  try {
    lookup = await apollo.getContactSequenceIds({
      contactId: ctx.apolloContactId,
      email: ctx.email,
    });
  } catch (err) {
    // Fail closed: an Apollo outage must not become an unscoped Attio write.
    return {
      allow: false,
      reason: 'apollo_lookup_failed',
      alert: true,
      detail: { error: err.message },
    };
  }

  if (!lookup.found) {
    return { allow: false, reason: 'contact_not_found_in_apollo', alert: true };
  }

  const matched = lookup.sequenceIds.filter(id => PREPPY_IDS.has(id));
  if (matched.length > 0) {
    return {
      allow: true,
      reason: 'preppy_sequence',
      sequenceIds: matched,
      apolloContact: lookup.contact || null,
    };
  }

  // Resolved, but not ours. Expected traffic now that other clients share
  // the workspace — logged, not alerted.
  return {
    allow: false,
    reason: 'contact not in a StraighterLine sequence',
    alert: false,
    detail: { sequenceIds: lookup.sequenceIds },
  };
}

// Read a number attribute off an Attio record, defaulting to 0.
function num(values, slug) {
  return Number(values?.[slug]?.[0]?.value) || 0;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') return bad(res, 'method not allowed', 405);
  if (!verifySecret(req)) return bad(res, 'unauthorized', 401);

  // An empty body is a real case, not an error: the Meeting Booked
  // workflow has historically POSTed nothing at all. Normalise to {} and
  // let the extractor decide — a body with no contact is skipped below
  // with a 200 so Apollo doesn't retry it forever.
  let body = req.body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) {
      body = {};
    } else {
      try { body = JSON.parse(trimmed); } catch (_) { return bad(res, 'invalid json'); }
    }
  }
  if (body === null || body === undefined) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) return bad(res, 'body must be a JSON object');

  const event = (req.query?.event || '').toLowerCase();
  if (!VALID_EVENTS.has(event)) {
    await alert('Apollo webhook missing/invalid ?event= hint', { event, sample: body });
    return bad(res, 'must specify ?event=opened|clicked|replied|bounced|finished|meeting');
  }

  try {
    console.log('[apollo-webhook]', event, JSON.stringify(body).slice(0, 500));
    const result = await dispatch(event, body);
    return ok(res, { event, result });
  } catch (err) {
    await alert('apollo-webhook handler error', { event, error: err.message, body });
    return fail(res, err);
  }
};

// --------------------------------------------------------------------

async function dispatch(event, body) {
  const ctx = extractContext(body);
  if (!ctx.email && !ctx.apolloContactId) {
    // Nothing to identify the contact by — most likely the Meeting Booked
    // workflow's empty body. Loud in the logs, but a 200 so Apollo stops
    // retrying; there is no work this request can do.
    await alert('Apollo webhook carried no contact_id and no email — nothing written to Attio', {
      event,
      bodyKeys: Object.keys(body || {}),
    });
    return { skipped: 'no_contact_identifier_in_payload' };
  }

  // StraighterLine-only guard — runs BEFORE any Attio call.
  const gate = await sequenceGate(ctx);
  const gateDetail = {
    event,
    contactId: ctx.apolloContactId,
    email: ctx.email,
    reason: gate.reason,
    ...(gate.detail || {}),
  };
  if (!gate.allow) {
    if (gate.alert) {
      await alert('Apollo webhook dropped — could not confirm a StraighterLine sequence; nothing written to Attio', gateDetail);
    } else {
      console.warn(`[apollo-webhook:${event}] skipped: ${gate.reason}`, JSON.stringify(gateDetail));
    }
    return { skipped: gate.reason, sequenceIds: gate.detail?.sequenceIds };
  }
  // The gate resolved the real sequence membership; trust it over the payload.
  ctx.sequenceId = gate.sequenceIds[0];

  // Apollo is authoritative for the contact's own details; the webhook
  // body is often thinner than the record the gate just resolved.
  const apolloContact = gate.apolloContact || {};
  if (!ctx.email && apolloContact.email) ctx.email = String(apolloContact.email).toLowerCase();
  if (!ctx.apolloContactId && apolloContact.id) ctx.apolloContactId = apolloContact.id;

  // Find the Attio person record. Prefer email lookup since Apollo Contact ID
  // is stored there but not always indexed.
  let attioPerson = ctx.email
    ? await attio.findPersonByEmail(ctx.email)
    : null;
  let attioPersonId = attioPerson?.id?.record_id;
  let created = false;

  if (!attioPerson) {
    // The contact is in a Preppy sequence (the gate above already proved
    // that and fails closed) but has no Attio record — historically these
    // events were dropped, which lost 77% of StraighterLine engagement.
    // Create the person, then let the normal event handlers write on top.
    if (!ctx.email) {
      // No email means no dedupe key, so a create would risk a duplicate
      // or a junk record. Skip rather than guess.
      console.warn(`[apollo-webhook:${event}] gated contact has no email — no record created`, ctx.apolloContactId);
      return { skipped: 'no_email_cannot_create', apolloContactId: ctx.apolloContactId };
    }

    // `company` in this workspace is a record-reference to Companies, so
    // the Apollo organisation NAME cannot be written to it. Left unset on
    // purpose — a wrong-typed write would be rejected or, worse, point at
    // the wrong company.
    const upserted = await attio.upsertPersonByEmail({
      email: ctx.email,
      firstName: ctx.firstName || apolloContact.first_name,
      lastName: ctx.lastName || apolloContact.last_name,
      fullName: apolloContact.name,
      jobTitle: ctx.title || apolloContact.title,
      apolloContactId: ctx.apolloContactId,
      assignedSequence: SEQUENCE_NAME_BY_ID[ctx.sequenceId],
      sourceBatchId: AUTOCREATE_BATCH_ID,
    });

    attioPersonId = upserted.recordId;
    // Re-read so the engagement handlers see real counter state. An assert
    // can match an existing record the email query missed; reading back is
    // what keeps counters from being clobbered back to 1.
    attioPerson = await attio.getPersonById(attioPersonId) || { id: { record_id: attioPersonId }, values: {} };
    created = true;
    console.log(`[apollo-webhook:${event}] created Attio person ${attioPersonId} for ${ctx.email}`);
  }

  let handled;
  switch (event) {
    case 'replied':   handled = await handleReplied(attioPersonId, ctx, attioPerson); break;
    case 'opened':    handled = await handleOpened(attioPersonId, ctx, attioPerson); break;
    case 'clicked':   handled = await handleClicked(attioPersonId, ctx, attioPerson); break;
    case 'bounced':   handled = await handleBounced(attioPersonId, ctx, attioPerson); break;
    case 'finished':  handled = await handleFinished(attioPersonId, ctx, attioPerson); break;
    case 'meeting':   handled = await handleMeeting(attioPersonId, ctx, attioPerson); break;
    case 'sent':      handled = await handleSent(attioPersonId, ctx, attioPerson); break;
  }
  return { ...handled, attioPersonId, personCreated: created };
}

/**
 * Fields written on EVERY event so the Apollo contact id and the sequence
 * name stay current on the Attio record regardless of which event fired.
 */
function commonAttrs(ctx) {
  const attrs = {};
  if (ctx.apolloContactId) attrs.apolloContactId = String(ctx.apolloContactId);
  const seqName = ctx.sequenceId && SEQUENCE_NAME_BY_ID[ctx.sequenceId];
  if (seqName) attrs.assignedSequence = seqName;
  return attrs;
}

// --------------------------------------------------------------------
// Per-event handlers
// --------------------------------------------------------------------

async function handleReplied(personId, ctx, attioPerson) {
  const now = new Date().toISOString();
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    outreachStage: 'Engaged',
    outboundStatus: 'Replied',
    lastEngagementDate: now,
    lastEngagementType: 'Replied',
    apolloSequenceStatus: 'Paused',
  });

  // Critical: post the reply body as an Attio note so Rebecca has something
  // to read in "Needs Human Touch." This is the only way the reply content
  // gets into Attio since email sync isn't connected for Rebecca yet.
  if (ctx.replyBody || ctx.replySubject) {
    await attio.createNoteOnPerson(personId, {
      title: ctx.replySubject ? `Reply: ${ctx.replySubject}` : 'Reply received',
      content: ctx.replyBody || '(no body in webhook payload)',
    });
  }

  // Belt-and-suspenders: explicitly remove from sequences. Apollo's native
  // "auto-remove on reply" should already have done this, but we don't
  // trust it 100%.
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try {
      await apollo.removeContactFromAllSequences(ctx.apolloContactId);
    } catch (err) {
      console.warn('[replied] redundant remove failed', err.message);
    }
  }

  return { stage: 'Engaged', notePosted: !!ctx.replyBody };
}

async function handleOpened(personId, ctx, attioPerson) {
  // Rapid-fire dedupe — Apollo often fires multiple open events from
  // image preloaders in quick succession, and a cold start or a second
  // concurrent Lambda can replay one that was already counted. The
  // in-process Map is only a fast path; the record's own `last_opened`
  // below is what makes the dedupe survive a cold start.
  if (ctx.apolloContactId && !shouldWriteOpenEvent(ctx.apolloContactId, 'opened')) {
    return { skipped: 'deduped' };
  }

  // Read current counter state from the Attio record.
  const values = attioPerson?.values || {};

  // Durable dedupe: this record's last counted open. Inside the 60-minute
  // window (config.OPEN_EVENT_DEDUPE_WINDOW_MINUTES) the event is treated
  // as a replay and nothing is written — deliberately conservative, since
  // an inflated open count produces a false "Flagged for Review" while a
  // missed one only delays the flag to the contact's next open.
  const lastOpenedAt = values.last_opened?.[0]?.value || null;
  if (isDuplicateOpen(lastOpenedAt)) {
    console.log(`[apollo-webhook:opened] deduped against last_opened=${lastOpenedAt} person=${personId}`);
    return { skipped: 'deduped_durable', lastOpened: lastOpenedAt };
  }
  const currentCount = Number(values.open_count_7d?.[0]?.value) || 0;
  const resetAt = values.opens_reset_at?.[0]?.value
    ? new Date(values.opens_reset_at[0].value)
    : null;
  const alreadyFlagged = !!values.flagged_for_review?.[0]?.value;

  // Is the existing window still valid?
  const now = new Date();
  const windowMs = ENGAGEMENT_OPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowValid = resetAt && (now.getTime() - resetAt.getTime()) < windowMs;

  let newCount, newResetAt;
  if (windowValid) {
    newCount = currentCount + 1;
    newResetAt = resetAt.toISOString();
  } else {
    // Window expired or never started — start fresh.
    newCount = 1;
    newResetAt = now.toISOString();
  }

  // Should we flag? Only if not already flagged (avoid redundant writes)
  // and we've hit the threshold.
  const shouldFlag = !alreadyFlagged && newCount >= ENGAGEMENT_OPEN_THRESHOLD;

  // Cumulative lifetime counter, separate from the rolling 7d window.
  const totalOpens = num(values, 'total_opens') + 1;

  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    lastEngagementDate: now.toISOString(),
    lastEngagementType: 'Opened',
    openCount7d: newCount,
    opensResetAt: newResetAt,
    totalOpens,
    lastOpened: now.toISOString(),
    ...(shouldFlag && { flaggedForReview: true }),
  });

  return {
    stage: 'unchanged',
    openCount: newCount,
    totalOpens,
    windowStart: newResetAt,
    flagged: shouldFlag,
  };
}

async function handleClicked(personId, ctx, attioPerson) {
  // Clicks are high-signal. Flag immediately.
  const values = attioPerson?.values || {};

  // Same durable dedupe as opens, against `last_clicked` and the
  // 60-minute CLICK_EVENT_DEDUPE_WINDOW_MINUTES. The first click of the
  // window already set flagged_for_review, so skipping a replay costs
  // nothing but a counter increment that never happened.
  if (ctx.apolloContactId && !shouldWriteOpenEvent(ctx.apolloContactId, 'clicked')) {
    return { skipped: 'deduped' };
  }
  const lastClickedAt = values.last_clicked?.[0]?.value || null;
  if (isDuplicateClick(lastClickedAt)) {
    console.log(`[apollo-webhook:clicked] deduped against last_clicked=${lastClickedAt} person=${personId}`);
    return { skipped: 'deduped_durable', lastClicked: lastClickedAt };
  }

  const now = new Date().toISOString();
  const totalClicks = num(attioPerson?.values, 'total_clicks') + 1;
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    lastEngagementDate: now,
    lastEngagementType: 'Clicked',
    totalClicks,
    lastClicked: now,
    flaggedForReview: true,
  });
  return { stage: 'unchanged', totalClicks, flagged: true };
}

async function handleBounced(personId, ctx, attioPerson) {
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    outboundStatus: 'Bounced',
    lastEngagementDate: new Date().toISOString(),
    lastEngagementType: 'Bounced',
    apolloSequenceStatus: 'Bounced',
    outreachStage: 'Do Not Contact', // dead address — stop everything
  });
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try { await apollo.removeContactFromAllSequences(ctx.apolloContactId); }
    catch (_) {}
  }
  return { stage: 'Do Not Contact' };
}

async function handleFinished(personId, ctx, attioPerson) {
  // Sequence completed naturally (all steps sent, no reply). Mark as such
  // but DON'T escalate to human touch — they didn't engage.
  const sequencesCompleted = num(attioPerson?.values, 'sequences_completed') + 1;
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    apolloSequenceStatus: 'Finished',
    sequencesCompleted,
  });
  return { stage: 'unchanged', sequenceStatus: 'Finished', sequencesCompleted };
}

async function handleMeeting(personId, ctx, attioPerson) {
  const now = new Date().toISOString();
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    outreachStage: 'Meeting Booked',
    outboundStatus: 'Meeting Booked',
    lastEngagementDate: now,
    lastEngagementType: 'Meeting Booked',
    apolloSequenceStatus: 'Paused',
  });
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try { await apollo.removeContactFromAllSequences(ctx.apolloContactId); }
    catch (_) {}
  }
  return { stage: 'Meeting Booked' };
}

/**
 * An email actually went out. Records that the contact is live in a
 * sequence; deliberately does NOT touch Outreach Stage, engagement
 * counters or the flag — a send is our action, not their engagement.
 */
async function handleSent(personId, ctx, attioPerson) {
  await attio.setEngagement(personId, {
    ...commonAttrs(ctx),
    apolloSequenceStatus: 'Active',
  });
  return { stage: 'unchanged', sequenceStatus: 'Active' };
}

// --------------------------------------------------------------------
// Payload extraction — adjust during Phase 3 testing once you see the
// real shapes Apollo posts.
// --------------------------------------------------------------------

function extractContext(body) {
  // Apollo workflow webhooks typically wrap the contact under `contact`
  // and the email/event details at the top level. Defensive against
  // multiple shapes.
  const contact = body?.contact || body?.data?.contact || body || {};
  const email =
    contact?.email ||
    body?.email ||
    body?.data?.email ||
    null;

  return {
    email: typeof email === 'string' ? email.toLowerCase() : null,
    apolloContactId: contact?.id || body?.contact_id || null,
    firstName: contact?.first_name,
    lastName: contact?.last_name,
    title: contact?.title,
    company: contact?.organization_name || contact?.account_name || contact?.company,
    sequenceId: body?.emailer_campaign_id || body?.sequence_id || null,
    replyBody:
      body?.reply_body ||
      body?.email_body ||
      body?.message?.body_text ||
      body?.data?.body_text ||
      null,
    replySubject:
      body?.reply_subject ||
      body?.subject ||
      body?.message?.subject ||
      null,
  };
}
