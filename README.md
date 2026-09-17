# preppy-bridge

Webhook bridge between **Attio** (where Rebecca lives) and **Apollo** (headless sequence execution). Plain Node serverless functions on Vercel.

## Architecture

```
Cold outbound (Jack owns):
  Flywheel → Apollo sequences
  Jack enrolls directly in Apollo
                    │
                    ▼
  Engagement events (opens/clicks/replies/bounces/meetings)
                    │
                    ▼
       Apollo workflow webhooks → bridge → Attio
                                            │
                        Engagement threshold logic:
                        - Click → Flagged for Review = true
                        - 3 opens / 7 days → Flagged for Review = true
                        - Reply → Outreach Stage = Engaged + note posted
                        - Meeting → Outreach Stage = Meeting Booked
                        - Bounce → Outreach Stage = Do Not Contact
                                            │
                                            ▼
                        ┌─────────────────────────────────┐
                        │  Attio: Needs Human Touch view  │
                        │  Rebecca works leads from here  │
                        └──────────────┬──────────────────┘
                                       │
                          Lead goes cold after Rebecca
                          has been working it manually
                                       │
                                       ▼
                        ┌─────────────────────────────────┐
                        │  Attio "Drip Re-engagement"     │
                        │  list — Rebecca drops them here │
                        └──────────────┬──────────────────┘
                                       │
                                   bridge
                                       │
                                       ▼
                        ┌─────────────────────────────────┐
                        │  Apollo "Bridge Drip" list      │
                        └──────────────┬──────────────────┘
                                       │
                              Apollo workflow
                                       │
                                       ▼
                        ┌─────────────────────────────────┐
                        │  Apollo drip sequence (slow,    │
                        │  low-touch periodic nudges)     │
                        └─────────────────────────────────┘
```

## File map

```
preppy-bridge/
├── api/
│   ├── attio-webhook.js        # drip_added, stage_changed, outbox_added
│   ├── apollo-webhook.js       # replied/opened/clicked/bounced/finished/meeting
│   ├── health.js
│   └── cron/
│       └── dead-mans-switch.js # daily drip path consistency check
├── lib/
│   ├── attio.js
│   ├── apollo.js
│   ├── http.js
│   ├── respond.js
│   ├── dedupe.js
│   └── notify.js
├── config.js                   # ⚠️ fill in APOLLO_DRIP_LIST_ID
├── vercel.json
├── package.json
├── .env.example
└── README.md
```

## Pre-deploy checklist

**1. Fill in `config.js`:**
`APOLLO_DRIP_LIST_ID` and `APOLLO_INBOX_LIST_ID` are `null` — the "Bridge Drip" and "Bridge Inbox" lists have not been recreated in the new Apollo workspace. Until they are, the Attio→Apollo drip path throws instead of running.

**2. Schema update in Attio:**
Before deploying, add two new attributes to the People object. The Chrome agent brief covers this.

| Attribute | Type |
|---|---|
| Open Count 7d | Number |
| Opens Reset At | Timestamp |

Without these attributes, the open-threshold logic will silently no-op because the writes will be rejected.

**3. Env vars (already set from v1):**
- `ATTIO_API_KEY`
- `APOLLO_API_KEY` (use the `preppy_flywheel` key, NOT Attio Connect)
- `WEBHOOK_SHARED_SECRET`
- `SLACK_ALERT_WEBHOOK_URL` (optional — when unset, alerts still print to `vercel logs` at error level, including an explicit "nobody was paged" line)

## Engagement threshold logic

Configurable in `config.js`:

```js
const ENGAGEMENT_OPEN_THRESHOLD      = 3;    // opens before flag
const ENGAGEMENT_OPEN_WINDOW_DAYS    = 7;    // rolling window
const OPEN_EVENT_DEDUPE_WINDOW_MINUTES = 60; // rapid-fire noise filter
```

**Open counter:** stored on the Attio record itself in `open_count_7d` and `opens_reset_at`. Every open event: dedupe first (60 min), then read counter, check if window is expired (if so, reset to 1), else increment. At `>= threshold`, set `flagged_for_review = true`.

**Clicks** bypass the counter and flag immediately.

**Flagged contacts stay in their cold sequence.** Apollo's native auto-remove-on-reply handles the cutoff when they actually engage back.

## Events handled

### Apollo → Attio (writeback)

Every event also writes `Apollo Contact ID` and `Assigned Sequence`.

| Event | Effect in Attio |
|---|---|
| `sent` | `Apollo Sequence Status = Active` (no engagement fields touched) |
| `opened` | `Total Opens` +1, `Last Opened`, `Last Engagement Date/Type`, 7d counter increment, flag if threshold hit |
| `clicked` | `Total Clicks` +1, `Last Clicked`, `Last Engagement Type = Clicked`, `Flagged for Review = true` |
| `replied` | `Outreach Stage = Engaged`, `Outbound Status = Replied`, `Apollo Sequence Status = Paused`, note created with reply body |
| `bounced` | `Outreach Stage = Do Not Contact`, `Outbound Status = Bounced`, `Apollo Sequence Status = Bounced` |
| `finished` | `Apollo Sequence Status = Finished`, `Sequences Completed` +1 (no stage change) |
| `meeting` | `Outreach Stage = Meeting Booked`, `Outbound Status = Meeting Booked` |

### StraighterLine-only scope guard

NUKO's Apollo workspace also runs CLIMB and Invigilator outbound, and the
Apollo workflows' only enrolment filter is `prospected_by_current_team` —
they will happily deliver other clients' engagement to this endpoint. The
webhook body carries **no sequence id**, so the URL cannot be trusted as
scope either.

Therefore `api/apollo-webhook.js` resolves every request against Apollo
(`contact_id`, falling back to `email`) and checks the contact's real
`emailer_campaign_ids` against `config.PREPPY_SEQUENCE_IDS` **before any
Attio call**. It **fails closed**:

| Outcome | Result |
|---|---|
| Contact is in a Preppy sequence | processed |
| Contact is only in non-Preppy sequences | skipped, logged `skipped: contact not in a StraighterLine sequence` |
| Contact is in zero sequences | skipped, same line |
| Contact not resolvable in Apollo | skipped **and alerted** |
| Apollo lookup errors | skipped **and alerted** |

All skips return HTTP 200 so Apollo does not retry. To admit a new Preppy
sequence, add its id to `PREPPY_SEQUENCE_IDS` — that is the only change
needed.

An **empty request body** is tolerated (the Meeting Booked workflow has
historically sent one): it is logged, alerted, and skipped with a 200
rather than throwing.

### Security

`WEBHOOK_SHARED_SECRET` fails **closed**: if the env var is unset the
endpoint rejects every request with 401 rather than running unauthenticated.
Secrets are compared in constant time.

### Attio → Apollo

| Event | Effect |
|---|---|
| `drip_added` | Upsert contact in Apollo, add to Bridge Drip list, Apollo workflow enrolls in drip sequence |
| `stage_changed` | DNC pauses sequence status in Attio (no Apollo call — gated endpoint) |
| `outbox_added` | Upsert contact in Apollo for enrichment |

**Cold sequence enrollment is NOT handled by the bridge.** Jack runs cold outbound directly in Apollo via the Flywheel.

## Webhook URLs

Existing URLs from v1 stay the same. One new Apollo webhook needs to be added:

```
POST https://preppy-bridge.vercel.app/api/apollo-webhook?event=<event>&secret=<SECRET>
```

`<event>` is one of `opened` `clicked` `replied` `bounced` `finished`
`meeting` (`sent` is also accepted). `<SECRET>` is the 64-char
`WEBHOOK_SHARED_SECRET` env var on the Vercel project. Auth is the query
secret only — Apollo workflows send no custom headers on these.

## Known gating

These Apollo endpoints are plan-gated on the current plan and the bridge does NOT call them:

- `/v1/emailer_campaigns/add_contact_ids`
- `/v1/emailer_campaigns/remove_contact_ids`
- `/v1/emailer_campaigns/{id}/add_contact_ids`

Instead: `PUT /v1/contacts/{id}` with `add_label_ids` / `remove_label_ids` is used for list membership, which an Apollo workflow translates into sequence enrollment.

## Operational notes

- **Open events are deduped** at 60 minutes by default (shorter than v1's 24h because we need real counts for the threshold logic, not just "ever opened")
- **Opens do NOT change `Outreach Stage`** — they only update counter + last engagement + flag
- **Flagged stays sticky** — once `Flagged for Review = true`, the bridge doesn't unflag. Rebecca unflags manually when she's done with the lead.
- **Dead-man's-switch** runs daily, narrowed to just the drip path (finds Attio Drip entries missing Apollo Contact ID)
- **No auto-heal** — the dead-man's-switch alerts only because the heal path would hit gated endpoints

## When something breaks

1. Check Vercel logs first
2. Check Slack for alerts
3. Hit `/api/health` to verify env vars
4. Most likely culprit: Attio payload shape changed — extractors may need updating
