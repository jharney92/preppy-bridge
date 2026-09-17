// ====================================================================
// config.js — bridge configuration
//
// SCOPE: StraighterLine / Preppy ONLY. The Attio workspace this bridge
// writes to is StraighterLine (workspace_slug "straighter-line"). NUKO's
// Apollo workspace also runs CLIMB and Invigilator outbound; events from
// those sequences must never reach StraighterLine's Attio. See
// PREPPY_SEQUENCE_IDS below — the Apollo webhook handler uses it as a
// strict, fail-closed allowlist.
//
// The Apollo workflow webhook body carries NO sequence id (it is
// {email, first_name, last_name, title, company, contact_id}), and the
// workflows' only enrolment filter is prospected_by_current_team. So the
// handler resolves each contact against Apollo and checks its actual
// sequence membership against PREPPY_SEQUENCE_IDS before writing. To let
// a new Preppy sequence through, add its id here — that is the only
// change required.
//
// ARCHITECTURE (final):
//
// - Jack runs all cold outbound directly in Apollo (via Flywheel).
//   The bridge does NOT enroll contacts in cold sequences.
//
// - Apollo engagement events (opens/clicks/replies/bounces/meetings)
//   flow into Attio as writeback. The bridge tracks opens on a rolling
//   7-day window; once a contact hits ENGAGEMENT_OPEN_THRESHOLD opens,
//   it sets Flagged for Review = true so Rebecca sees them in her
//   "Needs Human Touch" view. Clicks flag immediately. It also keeps
//   cumulative counters (Total Opens / Total Clicks / Sequences
//   Completed) and Last Opened / Last Clicked timestamps.
//
// - The ONLY Attio-originated Apollo path is the drip re-engagement
//   list: Rebecca drops a gone-cold lead in the Attio "Drip" list,
//   the bridge mirrors to Apollo's "Bridge Drip" list, and an Apollo
//   workflow picks it up and enrolls in a drip sequence.
// ====================================================================

// ====================================================================
// Apollo workspace migration (2026-09-17)
//
// NUKO moved to a NEW Apollo workspace; the OLD one deactivates
// ~2026-10-08. Every ID below is a NEW-workspace ID. The old values are
// kept in commented blocks purely for traceability.
// ====================================================================

// --- Sequences (NEW workspace) ------------------------------------
//
// Preppy / StraighterLine sequences. These are the live cold sequences
// whose engagement is allowed to write into StraighterLine's Attio.
const PREPPY_SEQUENCE_IDS = {
  'Cold-Preppy - Hospital Allied Health Outreach':                                        '6aa9a7f67c233b0020f82371',
  'Cold-Preppy/A/-250K Press Release (Control)':                                          '6aa897afed0be8001812ffd6',
  'Cold-Preppy-/B/-250K Press Release (long form copy)':                                  '6aa897a705907e00102af356',
  'Cold-Preppy-Sterile Processing Regulatory Trigger (MN)':                               '6aa89799dfc7a700141bd3ce',
  'Cold-Preppy-Surgical Tech / Sterile Processing — SMU Dallas Independent ASC Speed Play': '6aa8979105907e000c9ee177',
  'Cold-Preppy-Surgical Tech ASC Owner-Operator Speed Play':                              '6aa89788c6288f000c240be6',
  'Cold-Preppy-Hot Lead - Fast Follow + Phase-Out':                                       '6aa16e7b9bf68600101e0c0d',
};

// Non-Preppy sequences that also live in the same Apollo workspace.
// REFERENCE ONLY — the gate is a strict allowlist, so anything absent
// from PREPPY_SEQUENCE_IDS is already blocked. This list exists so a
// skipped id can be recognised at a glance in the logs. Engagement from
// these belongs to other clients and MUST NOT reach StraighterLine.
const NON_PREPPY_SEQUENCE_IDS = {
  'Cold-CLIMB-SPS / Internal OPM Schools':        '6aa58c771fd98c000c8ed0a5',
  'Cold-CLIMB-Career-Focused Nonprofit Schools':  '6aa58c32a230fa000c4ce3f3',
  'Cold-CLIMB-Whale-Tier Online Universities':    '6aa58bf71c05af00181872d3',
  'Cold-Invigilator-Peer-2-Peer Dan\'s Voice':    '6aa16e43bc33ed000c68afe6',
};

// old→new mapping applied on 2026-09-17 (matched by sequence name):
//   6a8f52bce2ab1200107d8039 Preppy 250K — Arm A: Short (Control)
//     → 6aa897afed0be8001812ffd6 Cold-Preppy/A/-250K Press Release (Control)
//   6a8f52d6e2ab1200107d80cc Preppy 250K — Arm B: Long-Form (Test)
//     → 6aa897a705907e00102af356 Cold-Preppy-/B/-250K Press Release (long form copy)
//   6a8dede2a2d53a00108edd66 Sterile Processing — Regulatory Trigger (MN)
//     → 6aa89799dfc7a700141bd3ce Cold-Preppy-Sterile Processing Regulatory Trigger (MN)
//   6a8f3eba6e1e69000c11e2ad Surgical Tech / Sterile Processing — SMU Dallas …
//     → 6aa8979105907e000c9ee177 Cold-Preppy-Surgical Tech / Sterile Processing — SMU Dallas …
//   6a8dedeb2082410010a6e09a Surgical Tech — ASC Owner-Operator Speed Play
//     → 6aa89788c6288f000c240be6 Cold-Preppy-Surgical Tech ASC Owner-Operator Speed Play
//   6a8df24e208241001460f860 Preppy Hot Lead — Fast Follow + Phase-Out
//     → 6aa16e7b9bf68600101e0c0d Cold-Preppy-Hot Lead - Fast Follow + Phase-Out
//   (new, no old counterpart) 6aa9a7f67c233b0020f82371 Cold-Preppy - Hospital Allied Health Outreach
//
// OLD-workspace sequence IDs, retained for reference only:
// const APOLLO_SEQUENCE_IDS_REFERENCE_OLD = {
//   'Automated Sequence':                    '69a5f9c5175aaa0011a52b6d',
//   'Preppy – Dept Heads – Referral Engine': '69d40c29e16fa90011eec03a',
//   'Preppy – Education Director – Rural':   '69d408c9160b4a00215cabef',
//   'Preppy – CNO – Rural Staffing':         '69d4052e6344f40019af033c',
//   'High-Touch Sequence':                   '69c6abc9b1641e0011c514d7',
// };

// --- Mailbox / sending user (NEW workspace) -----------------------
//
// StraighterLine's sending mailbox is jharney@straighterline.com,
// owned by Jack (jack.harney@wearenuko.com). Rebecca's old mailbox and
// user do not exist in the new workspace.
//
// OLD: APOLLO_DEFAULT_MAILBOX_ID = '6998baa2e1a5e90011234290' (Rebecca)
//      APOLLO_REBECCA_USER_ID    = '69a0649787ea9b00217d9cb9'
const APOLLO_DEFAULT_MAILBOX_ID = '6a79fefce989f70020198d4c'; // jharney@straighterline.com
const APOLLO_SEND_USER_ID       = '6aa032db66ea780018fb2e20'; // jack.harney@wearenuko.com

// --- Lists / labels (NEW workspace) -------------------------------
//
// NOT YET CREATED in the new workspace. The old-workspace IDs below are
// meaningless there, so they are left null on purpose: the Attio→Apollo
// drip path fails loudly instead of writing a foreign label id.
//
// OLD: APOLLO_DRIP_LIST_ID  = '69d7b41ba031ed000d1125e5' (Bridge Drip)
//      APOLLO_INBOX_LIST_ID = '69d65c6b00b0d30015c0eafa' (Bridge Inbox)
const APOLLO_DRIP_LIST_ID  = null;
const APOLLO_INBOX_LIST_ID = null;

// No Apollo custom-field IDs are used by the bridge — it writes no
// typed_custom_fields. Nothing to remap there.

// ====================================================================
// Engagement threshold settings
// ====================================================================

// How many opens within the rolling window before a contact gets flagged.
const ENGAGEMENT_OPEN_THRESHOLD = 3;

// Rolling window in days for the open counter. If a contact hasn't hit
// the threshold within this window, the counter resets on the next open.
const ENGAGEMENT_OPEN_WINDOW_DAYS = 7;

// Noise dedupe: the SAME open event may fire multiple times from image
// preloaders, and a serverless cold start or a second concurrent Lambda
// can replay one that a previous invocation already counted. Within this
// window a contact's repeat open is not counted again. The check is made
// against the Attio record's own `last_opened`, so it holds across
// processes — see lib/dedupe.js.
const OPEN_EVENT_DEDUPE_WINDOW_MINUTES = 60;

// Same rule for clicks, compared against `last_clicked`. Clicks are rarer
// than opens, but a link with a tracking redirect can still fire twice.
const CLICK_EVENT_DEDUPE_WINDOW_MINUTES = 60;

// ====================================================================
// Behavior knobs
// ====================================================================

// Direct API removal hits the plan-gated endpoint. Rely on Apollo's
// native "auto-remove on reply" instead.
const ENABLE_REDUNDANT_APOLLO_REMOVAL = false;

// Dead-man's-switch auto-heal: same gating issue. Alert only.
const DEAD_MANS_SWITCH_AUTO_HEAL = false;

module.exports = {
  PREPPY_SEQUENCE_IDS,
  NON_PREPPY_SEQUENCE_IDS,
  APOLLO_DRIP_LIST_ID,
  APOLLO_INBOX_LIST_ID,
  APOLLO_DEFAULT_MAILBOX_ID,
  APOLLO_SEND_USER_ID,
  ENGAGEMENT_OPEN_THRESHOLD,
  ENGAGEMENT_OPEN_WINDOW_DAYS,
  OPEN_EVENT_DEDUPE_WINDOW_MINUTES,
  CLICK_EVENT_DEDUPE_WINDOW_MINUTES,
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
  DEAD_MANS_SWITCH_AUTO_HEAL,
};
