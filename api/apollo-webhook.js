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
// outbound. This endpoint writes ONLY into StraighterLine's Attio, so any
// event carrying a sequence id that is not a known Preppy sequence is
// dropped before the Attio lookup (see config.PREPPY_SEQUENCE_IDS).
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
// Routing strategy: prefer ?event= hint in the webhook URL, fall back to
// sniffing the payload shape.
// ====================================================================

const { ok, bad, fail, verifySecret } = require('../lib/respond');
const attio = require('../lib/attio');
const apollo = require('../lib/apollo');
const { shouldWriteOpenEvent } = require('../lib/dedupe');
const { alert } = require('../lib/notify');
const {
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
  ENGAGEMENT_OPEN_THRESHOLD,
  ENGAGEMENT_OPEN_WINDOW_DAYS,
  PREPPY_SEQUENCE_IDS,
  NON_PREPPY_SEQUENCE_IDS,
  REQUIRE_KNOWN_PREPPY_SEQUENCE,
} = require('../config');

const VALID_EVENTS = new Set(['replied', 'opened', 'clicked', 'bounced', 'finished', 'meeting', 'sent']);

const PREPPY_IDS     = new Set(Object.values(PREPPY_SEQUENCE_IDS));
const NON_PREPPY_IDS = new Set(Object.values(NON_PREPPY_SEQUENCE_IDS));

// Maps an Apollo sequence id to a name for the Attio "Assigned Sequence"
// text field.
const SEQUENCE_NAME_BY_ID = Object.fromEntries(
  Object.entries(PREPPY_SEQUENCE_IDS).map(([name, id]) => [id, name])
);

/**
 * Decide whether an event belongs to StraighterLine.
 *
 * - No sequence id in the payload: allow. The Apollo workflow that calls
 *   this URL is itself scoped to a Preppy sequence, so the URL is the
 *   scope. Logged so an unexpected source is still visible.
 * - Known Preppy id: allow.
 * - Known non-Preppy id (CLIMB, Invigilator): drop, quietly — this is
 *   expected traffic if a workflow is ever mis-pointed.
 * - Unknown id: drop and alert. A new Preppy sequence needs adding to
 *   config.PREPPY_SEQUENCE_IDS; anything else is another client's data.
 */
function sequenceGate(sequenceId) {
  if (!sequenceId) return { allow: true, reason: 'no_sequence_id_in_payload' };
  if (PREPPY_IDS.has(sequenceId)) return { allow: true, reason: 'preppy' };
  if (NON_PREPPY_IDS.has(sequenceId)) {
    return { allow: false, reason: 'non_preppy_sequence', alert: false };
  }
  if (!REQUIRE_KNOWN_PREPPY_SEQUENCE) return { allow: true, reason: 'unknown_sequence_allowed_by_config' };
  return { allow: false, reason: 'unknown_sequence', alert: true };
}

// Read a number attribute off an Attio record, defaulting to 0.
function num(values, slug) {
  return Number(values?.[slug]?.[0]?.value) || 0;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') return bad(res, 'method not allowed', 405);
  if (!verifySecret(req)) return bad(res, 'unauthorized', 401);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return bad(res, 'invalid json'); }
  }
  if (!body) return bad(res, 'empty body');

  const event = (req.query?.event || '').toLowerCase();
  if (!VALID_EVENTS.has(event)) {
    await alert('Apollo webhook missing/invalid ?event= hint', { event, sample: body });
    return bad(res, `must specify ?event=replied|opened|clicked|bounced|finished|meeting`);
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
    throw new Error('apollo webhook payload missing both email and contact_id');
  }

  // StraighterLine-only guard — runs BEFORE any Attio call.
  const gate = sequenceGate(ctx.sequenceId);
  if (!gate.allow) {
    const detail = { event, sequenceId: ctx.sequenceId, reason: gate.reason };
    if (gate.alert) {
      await alert('Apollo webhook from an unrecognised sequence — dropped, nothing written to Attio', detail);
    } else {
      console.warn('[apollo-webhook] dropped non-Preppy sequence event', JSON.stringify(detail));
    }
    return { skipped: gate.reason, sequenceId: ctx.sequenceId };
  }

  // Find the Attio person record. Prefer email lookup since Apollo Contact ID
  // is stored there but not always indexed.
  const attioPerson = ctx.email
    ? await attio.findPersonByEmail(ctx.email)
    : null;
  if (!attioPerson) {
    console.warn(`[apollo-webhook:${event}] no Attio person for email ${ctx.email}`);
    return { skipped: 'no_attio_person', email: ctx.email };
  }
  const attioPersonId = attioPerson?.id?.record_id;

  switch (event) {
    case 'replied':   return handleReplied(attioPersonId, ctx, attioPerson);
    case 'opened':    return handleOpened(attioPersonId, ctx, attioPerson);
    case 'clicked':   return handleClicked(attioPersonId, ctx, attioPerson);
    case 'bounced':   return handleBounced(attioPersonId, ctx, attioPerson);
    case 'finished':  return handleFinished(attioPersonId, ctx, attioPerson);
    case 'meeting':   return handleMeeting(attioPersonId, ctx, attioPerson);
    case 'sent':      return handleSent(attioPersonId, ctx, attioPerson);
  }
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
  // image preloaders in quick succession. The dedupe window (default 60
  // min) collapses these so one real visit = one count increment.
  if (ctx.apolloContactId && !shouldWriteOpenEvent(ctx.apolloContactId)) {
    return { skipped: 'deduped' };
  }

  // Read current counter state from the Attio record.
  const values = attioPerson?.values || {};
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
