// ====================================================================
// lib/dedupe.js — engagement-event dedupe (durable)
//
// Apollo open events are noisy: ~40% open rate × hundreds of contacts
// means thousands of opens/day, many of them duplicates from image
// preloaders. We collapse repeats to "at most one counted event per
// contact per window."
//
// TWO LAYERS, and only the second one is load-bearing:
//
//   1. FAST PATH — an in-process Map keyed on the Apollo contact id.
//      Saves an Attio round trip on a warm Lambda. Purely an
//      optimisation: it is allowed to be empty, stale, or wiped by a
//      cold start without affecting correctness.
//
//   2. DURABLE PATH — the Attio record itself. Before an open is
//      counted, the record's `last_opened` is compared against now; a
//      click likewise against `last_clicked`. If the previous event of
//      the same kind landed inside the window, this one is a replay and
//      is not counted. The record is the only state that survives a
//      cold start, a redeploy, or a second concurrent Lambda, so
//      correctness rests there and nowhere else.
//
// WINDOW: 60 minutes (config.OPEN_EVENT_DEDUPE_WINDOW_MINUTES for opens,
// CLICK_EVENT_DEDUPE_WINDOW_MINUTES for clicks). Chosen deliberately
// long. The counters feed "Flagged for Review" thresholds, so an
// inflated count is a false alarm that wastes Rebecca's time, while a
// missed one only delays a flag until the contact's next open. Two
// genuine opens by the same human inside an hour are therefore counted
// once, on purpose.
//
// Note the durable comparison is against arrival time, not an event
// timestamp: Apollo's workflow webhook body carries no timestamp
// (it is {email, first_name, last_name, title, company, contact_id}).
// A replay of the same event therefore lands with a `last_opened` only
// seconds old, well inside the window, and a clock skew that puts
// `last_opened` in the future also reads as "inside the window" — both
// resolve to "do not count", which is the conservative direction.
// ====================================================================

const {
  OPEN_EVENT_DEDUPE_WINDOW_MINUTES,
  CLICK_EVENT_DEDUPE_WINDOW_MINUTES,
} = require('../config');

const _seen = new Map(); // `${kind}:${contactId}` → lastSeenMs

/**
 * Fast path only. A `false` means "definitely a repeat inside the
 * window, skip the Attio round trip"; a `true` means nothing more than
 * "this process has not seen it" — the durable check still decides.
 */
function shouldWriteOpenEvent(contactId, kind = 'opened') {
  const now = Date.now();
  const key = `${kind}:${contactId}`;
  const last = _seen.get(key);
  const windowMinutes = kind === 'clicked'
    ? CLICK_EVENT_DEDUPE_WINDOW_MINUTES
    : OPEN_EVENT_DEDUPE_WINDOW_MINUTES;
  const windowMs = windowMinutes * 60 * 1000;
  if (last && now - last < windowMs) return false;
  _seen.set(key, now);
  // Trim if Map grows too large (keep last 5000)
  if (_seen.size > 5000) {
    const cutoff = now - windowMs;
    for (const [k, v] of _seen) if (v < cutoff) _seen.delete(k);
  }
  return true;
}

/**
 * Durable check, run against the Attio record's own timestamp.
 *
 * @param {string|Date|null} lastEventAt  record's last_opened / last_clicked
 * @param {number} windowMinutes
 * @param {Date} [now]
 * @returns {boolean} true when the event is a replay and must not count
 */
function isReplayWithinWindow(lastEventAt, windowMinutes, now = new Date()) {
  if (!lastEventAt) return false;
  const last = lastEventAt instanceof Date ? lastEventAt : new Date(lastEventAt);
  const lastMs = last.getTime();
  if (!Number.isFinite(lastMs)) return false; // unparseable stamp — count it
  return now.getTime() - lastMs < windowMinutes * 60 * 1000;
}

function isDuplicateOpen(lastOpenedAt, now = new Date()) {
  return isReplayWithinWindow(lastOpenedAt, OPEN_EVENT_DEDUPE_WINDOW_MINUTES, now);
}

function isDuplicateClick(lastClickedAt, now = new Date()) {
  return isReplayWithinWindow(lastClickedAt, CLICK_EVENT_DEDUPE_WINDOW_MINUTES, now);
}

module.exports = {
  shouldWriteOpenEvent,
  isReplayWithinWindow,
  isDuplicateOpen,
  isDuplicateClick,
};
