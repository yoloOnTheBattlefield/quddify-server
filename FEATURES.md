# Features

## Client User Isolation (Multi-Tenancy Fix)

When `POST /api/clients` provisions a login for a new client (email + password), the backend now creates a dedicated `Account` for that user instead of adding them as a member of the creator's account. Previously, the client user was attached to `req.account._id` as a role-2 member, but only `GET /api/clients` enforced role-2 scoping — every other data route (bookings, outbound leads, analytics, reports, campaigns, etc.) filtered solely by `account_id`, so a newly provisioned client user could log in and see all of the creator's data.

The `Client` document itself remains in the creator's account so the creator continues to manage it; only the client user's login is isolated.

### Files

- `routes/clients.js` — `POST /api/clients` creates a fresh `Account`, a `User` bound to that account, and an `AccountUser` (role 1, `is_default: true`) for the new isolated tenant.
- `scripts/isolate-client-users.js` — One-shot migration that finds existing client users still attached to their creator's account and moves them into their own isolated account. Supports `--apply` and `--email <addr>` flags; dry run by default.

## Telegram Integration

Send Telegram notifications when new inbound leads are created, and when the DM Assistant marks an outbound lead with a follow-up. Highlights when an inbound lead is linked to an outbound lead, showing the lead's username and the IG sender account that DMed them.

### Files

- `models/Account.js` — `telegram_bot_token` (encrypted) and `telegram_chat_id` fields
- `services/telegramNotifier.js` — Sends Telegram messages via Bot API. Exposes `notifyNewLead`, `notifyCampaignCompleted`, and `notifyAiFollowUp` (fires when AI creates a brand-new FollowUp doc OR transitions a lead into the `follow_up_later` status)
- `services/dmAssistantService.js` — In `upsertLeadAndFollowUp`, reads the prior FollowUp state, then after upserting calls `notifyAiFollowUp` for new FollowUps and for transitions into `follow_up_later`
- `routes/telegram.js` — Connect/disconnect endpoints with test message validation
- `routes/calendly.js` — Fires Telegram notification on Calendly webhook lead creation
- `routes/leads.js` — Fires Telegram notification on direct lead creation

### API Routes — `/api/telegram`

| Method | Path        | Description                                          |
| ------ | ----------- | ---------------------------------------------------- |
| POST   | /connect    | Save bot token + chat ID, send test message          |
| DELETE | /disconnect | Remove Telegram configuration                        |

## GHL Webhook

Replaces the n8n "DM tracking sheets" workflow. Receives GHL contact webhooks, creates or updates leads based on tags, syncs outbound funnel status, and fires Telegram notifications.

### Files

- `routes/ghl-webhook.js` — Webhook endpoint: upsert lead by contact_id, map GHL tags to funnel fields

### API Routes — `/api/ghl` (public, no auth)

| Method | Path     | Description                                          |
| ------ | -------- | ---------------------------------------------------- |
| POST   | /webhook | Create lead or update funnel field from GHL tags     |

### Tag Mapping

| GHL Tag           | Lead Field      |
| ----------------- | --------------- |
| ghosted           | ghosted_at      |
| lead_booked       | booked_at       |
| booking_link      | booked_at       |
| booking_process   | qualified_at    |
| follow_up/followup| follow_up_at    |
| low_ticket        | low_ticket      |
| link_sent         | link_sent_at    |

## Mock Lead Generator (Admin)

Admin-only endpoint that bulk-creates synthetic leads for any account, used by the dm-setting `/settings` page to seed demo/staging data. Generates a configurable funnel distribution (link_sent / booked / ghosted / follow_up / closed) with realistic timestamps, IG-style Q&A on booked leads, and optional contract values.

### Files

- `routes/leads.js` — `POST /leads/generate` handler
- `routes/leads.test.js` — Unit tests including regressions for the two bugs below
- `apps/dm-setting/src/pages/UserSettings.tsx` — Frontend form (account dropdown + funnel inputs)

### API Routes

| Method | Path             | Description                                   |
| ------ | ---------------- | --------------------------------------------- |
| POST   | /leads/generate  | Insert mock leads for `body.ghl` (admin only) |

### Account targeting (important)

The endpoint targets the account chosen in the dropdown via `body.ghl`, NOT the authenticated admin's own account. The handler resolves `body.ghl` → `Account._id` and writes leads with `account_id: account._id.toString()`.

### Past bugs (regression tests cover both)

1. **Wrong account used.** The handler originally read `req.account.ghl` and ignored `body.ghl` entirely, so leads landed under the admin's own account regardless of which account the dropdown selected.
2. **GHL string stored as account_id.** Leads were inserted with `account_id: ghl` (the raw GHL location string like `pkXiD3IjJQZccab8ABZ6`). The dashboard queries by `Account._id.toString()` (post-2026-04-02 migration), so they were invisible. This mirrors the GHL webhook fix from 2026-04-02.

## Advisory Module

Track advisory/coaching clients, their sessions, and monthly business metrics.

### Files

- `models/AdvisoryClient.js` — Client model (name, niche, revenue, constraint type, health status)
- `models/AdvisorySession.js` — Session model (call notes, action items, bottleneck tracking)
- `models/AdvisoryMetric.js` — Monthly metrics model (MRR, cash collected, call stats, expenses)
- `schemas/advisory-schemas.js` — Zod validation schemas for all advisory endpoints
- `routes/advisory-clients.js` — Client CRUD routes
- `routes/advisory-sessions.js` — Session CRUD routes
- `routes/advisory-metrics.js` — Metrics CRUD and summary routes

### API Routes

#### Clients — `/api/advisory/clients`

| Method | Path  | Description                                              |
| ------ | ----- | -------------------------------------------------------- |
| GET    | /     | Paginated list, filterable by status/health, searchable  |
| POST   | /     | Create a new advisory client                             |
| GET    | /:id  | Single client with latest session and latest metric      |
| PATCH  | /:id  | Update any client field                                  |
| DELETE | /:id  | Soft delete (sets status to "churned")                   |

#### Sessions — `/api/advisory/sessions`

| Method | Path  | Description                                              |
| ------ | ----- | -------------------------------------------------------- |
| GET    | /     | Paginated list, filterable by client_id, sorted by date  |
| POST   | /     | Create session with action items                         |
| GET    | /:id  | Single session                                           |
| PATCH  | /:id  | Update session or toggle action item completion          |
| DELETE | /:id  | Hard delete                                              |

#### Metrics — `/api/advisory/metrics`

| Method | Path     | Description                                           |
| ------ | -------- | ----------------------------------------------------- |
| GET    | /summary | Aggregate summary for current month across all clients |
| GET    | /        | List metrics, filterable by client_id                  |
| POST   | /        | Upsert metric by client_id + month                    |
| PATCH  | /:id     | Update specific metric fields                         |

## Quick-note Dialog (LeadNote Extension)

Notes can now be attached to outbound leads in addition to inbound leads.

### Files

- `models/LeadNote.js` — Added `outbound_lead_id` field, made `lead_id` optional
- `routes/lead-notes.js` — GET/POST accept `outbound_lead_id` as alternative to `lead_id`

### API Routes — `/api/lead-notes`

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | /    | List notes by `lead_id` or `outbound_lead_id` query param |
| POST   | /    | Create note with `lead_id` or `outbound_lead_id` |
| DELETE | /:id | Delete note (unchanged) |

## Score-based Analytics

Outbound leads can be scored (1-10) and analytics aggregated by score tier.

### Files

- `models/OutboundLead.js` — Added `score` field
- `schemas/outbound-leads.js` — Added `score` to patch validation
- `routes/analytics.js` — Added `GET /outbound/score-breakdown` endpoint

### API Routes — `/analytics/outbound`

| Method | Path              | Description |
| ------ | ----------------- | ----------- |
| GET    | /score-breakdown  | Score tier analytics (reply/book/close rates per tier) |

## Weekly Heatmap

Visualize outbound activity by day-of-week and hour.

### Files

- `routes/analytics.js` — Added `GET /outbound/weekly-heatmap` endpoint

### API Routes — `/analytics/outbound`

| Method | Path            | Description |
| ------ | --------------- | ----------- |
| GET    | /weekly-heatmap | Activity heatmap (sent/replied/booked by day+hour) |

## EOD Reports

End-of-day reports with auto-populated stats, team checklist, and mood tracking.

### Files

- `models/EodReport.js` — Report model (stats, checklist, notes, mood)
- `routes/eod-reports.js` — Full CRUD + today auto-create + team view
- `routes/eod-reports.test.js` — Jest + Supertest tests

### API Routes — `/api/eod-reports`

| Method | Path   | Description |
| ------ | ------ | ----------- |
| GET    | /today | Get or auto-create today's report with live stats |
| GET    | /team  | All team members' reports for a date |
| GET    | /      | Paginated list with date/user filters |
| POST   | /      | Upsert today's report (checklist, notes, mood) |
| PATCH  | /:id   | Update report fields |

## Bookings Module

Track and manage booking calls with analytics, syncing from leads.

### Files

- `models/Booking.js` — Booking model (contact, dates, status, revenue)
- `routes/bookings.js` — Full CRUD + stats + analytics + sync
- `routes/bookings.test.js` — Jest + Supertest tests

### API Routes — `/api/bookings`

| Method | Path       | Description |
| ------ | ---------- | ----------- |
| GET    | /stats     | Aggregate counts by status + today count |
| GET    | /analytics | Close rate, show-up rate, avg cash, over time |
| GET    | /          | Paginated list with filters and lead lookups |
| GET    | /:id       | Single booking with populated lead data |
| POST   | /          | Create booking |
| PATCH  | /:id       | Update booking (auto-sets timestamps) |
| DELETE | /:id       | Delete booking |
| POST   | /sync      | Create bookings from existing booked leads |

## Email Invitations

Send email invitations to onboard new clients or team members. Invitations are sent via Resend and include a unique token link. Recipients can accept the invite to create their account or join an existing one.

### Files

- `models/Invitation.js` — Invitation model (email, token, type, status, expiry)
- `routes/invitations.js` — Invitation endpoints (create, validate, accept)

### API Routes — `/api/invitations`

| Method | Path            | Auth   | Description                                       |
| ------ | --------------- | ------ | ------------------------------------------------- |
| POST   | /               | Admin  | Create invitation and send email (role 0 only)    |
| GET    | /:token         | Public | Validate an invitation token                      |
| POST   | /:token/accept  | Public | Accept invitation, create user/account, return JWT |
