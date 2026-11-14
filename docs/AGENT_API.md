# IG CRM agent API

This is the state store for the Instagram DM agent on @cristiandealflow. It replaces
`bonnie-leads.md`, `bot-sent.log` and `state.json`. The CRM is the only place where a
lead's stage, the facts about them, the skip flag, the lead magnet status and the
message log live.

```
Base URL:  https://server-production-38bfcd7a.up.railway.app/api/agent
Auth:      x-api-key: $IGCRM_API_KEY        (every request)
Body:      JSON, Content-Type: application/json
Times:     ISO 8601 with offset, e.g. 2026-11-14T15:24:00Z
```

In the examples, `H` stands for the two headers:

```bash
H=(-H "x-api-key: $IGCRM_API_KEY" -H "Content-Type: application/json")
API=https://server-production-38bfcd7a.up.railway.app/api/agent
```

## Contacts and `:ref`

A contact is one person. Everywhere a path says `:ref`, you can pass any one of:

| ref | example |
|---|---|
| Zernio conversation id | `6af8aa11bb22cc33dd44ee0f` |
| IG scoped user id (the participant id, digits) | `1456618667530017` |
| Instagram handle, with or without `@` (URL-encode `@` as `%40`) | `%40lead_handle` |

Lookup tries them in that order. A new person who DMs the account becomes a contact
automatically, with `source: "ig_dm"` and `stage: "new"`. Incoming messages are logged
automatically. **Outgoing messages are not logged automatically**: you must post every
bubble you send, and every message Cristian sends, with `POST /messages`.

### The contact object

Every contact response returns this shape:

```json
{
  "id": "6736…",
  "ig_username": "lead_handle", "ig_user_id": "1456618667530017",
  "zernio_conversation_id": "6af8…0f",
  "first_name": null, "last_name": null, "email": null,
  "source": "bonnie_story",
  "source_type": "story", "source_label": "Bonnie story",
  "source_media_id": null, "source_url": null,
  "stage": "qualifying",
  "stage_history": [{ "from": "new", "to": "qualifying", "at": "…", "by": "agent" }],
  "skip": false, "skip_reason": null,
  "language": "en",
  "industry": "M&A, micro-cap, France", "offer": "sell-side advisory", "buyer": "founders exiting",
  "ticket_size": "fee 5-10% of sale price", "monthly_revenue": "~40k/mo", "monthly_revenue_usd": 40000,
  "pain": "no deal flow",
  "summary": null,
  "pitch": { "offer": "sprint_5k", "amount": 5000, "counter": null, "at": "…" },
  "lead_magnet": { "status": "posted", "brief": "…", "ideas": "…", "doc_url": null,
                   "slack_posted_at": "…", "sent_at": null },
  "live": false, "live_until": null,
  "last_inbound_at": "…", "last_outbound_at": "…", "last_bot_send_at": "…",
  "follow_up_at": null, "booked_at": null, "closed_at": null,
  "contract_value": null, "score": null, "created_at": "…"
}
```

These are the allowed values:

- `stage`: `new`, `qualifying`, `pain`, `teaser`, `pitched`, `negotiating`, `booked`, `won`, `lost`
- `pitch.offer`: `sprint_5k` ($5,000 for 90 days) or `consult_500` ($500 for one hour)
- `lead_magnet.status`: `none`, `posted` (brief posted to Slack), `building`, `built`, `sent`
- `language`: `en`, `ro`
- `source_type`: `story`, `reel`, `post`, `comment`, `organic`, `other`
- `live`: true while Cristian is replying himself. It is set for 60 minutes from his last
  message that you posted with `sent_by: "cristian"`. **While `live` is true, do not
  reply.**

Moving `stage` to `pitched`, `booked`, `won` or `lost` also stamps the dashboard funnel
dates. You never set those dates yourself.

## The loop for one DM

The webhook fires with an event type and a Zernio conversation id. Call it `$CONV`.

### 1. Take the lock (one run per conversation)

```bash
curl -s "${H[@]}" -X POST $API/locks/$CONV -d '{"run_id":"run-2026-11-14T15:24:03Z-abc","ttl_seconds":120}'
```

- `200 {"acquired":true,"run_id":"…","expires_at":"…","contact_id":"…"}`: continue.
- `409 {"acquired":false,"held_by":"run-…","expires_at":"…"}`: another run already
  has this conversation. **Stop and do nothing.**
- `404`: no contact yet. That happens when the event arrived before the CRM stored the
  first message. Create the contact (step 2b), then take the lock.

Use a new unique `run_id` per run. Calling again with the same `run_id` extends your
own lock.

### 2. Read the contact and the recent thread

```bash
curl -s "${H[@]}" $API/contacts/$CONV
```

This returns `{"contact": <contact>, "messages": [...], "lock": {...} | null}`. It
includes the last 30 messages, oldest first:
`{"id","direction":"inbound|outbound","sent_by":"lead|bot|cristian|unknown","text","at","zernio_message_id"}`.

Stop here (and release the lock, step 6) if:

- `contact.skip` is true
- `contact.live` is true, because Cristian is in the thread

2b. If it's unknown (`404`), create the contact with whatever you know:

```bash
curl -s "${H[@]}" -X PUT $API/contacts/$CONV -d '{"ig_user_id":"1456618667530017","ig_username":"lead_handle","source":"organic_dm"}'
```

This returns `201 {"created":true,"contact":…}`. If the contact already existed, you
get `200 {"created":false,…}`, so it is safe to repeat.

### 3. Check whether another run already replied

```bash
curl -s "${H[@]}" "$API/events?ref=$CONV&since=2026-11-14T15:20:00Z"
```

This returns `{"since","messages":[…],"stage_changes":[…],"last_bot_send_at","live"}`.
If there is a `bot` message after the lead's latest inbound message, that message has
already been answered. Stop.

### 4. Send, then log every bubble

Send each bubble through Zernio as you do now. **Right after each send**, post it with the
message id Zernio returned:

```bash
curl -s "${H[@]}" -X POST $API/messages -d '{"ref":"'$CONV'","zernio_message_id":"<id from Zernio>","text":"<bubble text>","sent_by":"bot"}'
```

This returns `201 {"stored":true,"duplicate":false,"message":…,"contact":…}`. Posting
the same `zernio_message_id` again returns `200 {"stored":false,"duplicate":true}`, so
retries are safe.

**When you see a message from Cristian in the Zernio thread** (an outgoing message that
you didn't send), post it once with `"sent_by":"cristian"`. That makes the contact `live`
for 60 minutes. Pass `sent_at` with the real send time if it wasn't just now.

### 5. Save what you learned

`PATCH` only the fields that changed. Unknown fields are rejected with
`400 {"unknown_fields":[…],"allowed_fields":[…]}`.

```bash
# qualification facts
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"stage":"qualifying","language":"en","industry":"M&A","offer":"sell-side advisory","ticket_size":"fee 5-10%","monthly_revenue":"~40k/mo","monthly_revenue_usd":40000,"pain":"no deal flow"}'

# lead magnet brief posted to #lead-magnets
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"lead_magnet":{"status":"posted","brief":"<the brief you posted>","ideas":"<1-2 ideas>","slack_posted_at":"2026-11-14T15:30:00Z"}}'

# pitch
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"stage":"pitched","pitch":{"offer":"sprint_5k","amount":5000}}'

# negotiation (hand to Cristian)
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"stage":"negotiating","pitch":{"counter":"1k a month"}}'

# booked, won, lost
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"stage":"booked"}'
```

Rules for writing:

- `pitch` and `lead_magnet` merge. Send only the sub-fields that changed.
- **Before posting a brief to Slack**, check `contact.lead_magnet.status`. If it isn't
  `none`, the brief was already posted. Don't post it again.
- The over-$10k-a-month rule reads `monthly_revenue_usd`, so always set it when you
  know the number.

### 5b. Record where the lead came from (once)

Set the source the first time you can tell. If `contact.source_type` is already set, leave
it alone: the first touch wins.

| What you see in the thread | Set |
|---|---|
| Reply to a story (theirs or someone else's, e.g. Bonnie's) | `source_type: "story"`, `source_label: "Bonnie story"` (who or what the story was) |
| They shared or named one of Cristian's reels or posts | `source_type: "reel"` (or `"post"`), `source_label: "System reel"`, `source_url: "<the reel URL>"` |
| They commented a keyword and the automation DMed them | nothing, the automation sets `source_type: "comment"` itself |
| A plain DM with no story, reel or comment | `source_type: "organic"` |
| Anything else | `source_type: "other"` plus a `source_label` |

```bash
curl -s "${H[@]}" -X PATCH $API/contacts/$CONV -d '{"source_type":"reel","source_label":"System reel","source_url":"https://www.instagram.com/reel/DdHIlYTANWd/"}'
```

When you send a `source_url` for one of Cristian's posts or reels, the CRM finds the post by
its shortcode (`/reel/X/`, `/reels/X/`, `/p/X/`, `/tv/X/`) and fills `source_media_id`
itself. That is what credits the lead to the post on the Content page. If the post isn't in
the CRM's post list yet (it syncs daily), `source_media_id` stays null; the label still
counts in the by-source totals. Send `source_media_id` directly only if you have the
Instagram media id.

### 5c. Keyword with no comment rule

When a lead mentions a comment keyword (for example "SYSTEM") that has no active comment
rule, the comment automation never fired for them. Check once per keyword:

```bash
curl -s "${H[@]}" https://server-production-38bfcd7a.up.railway.app/api/comment-rules
# → {"rules":[{"name":"…","keywords":["…"],"active":true,…}]}
```

If no active rule has that keyword (case-insensitive), alert Cristian once:
`No comment rule for keyword "SYSTEM" (seen from @handle).` Don't repeat the alert for the
same keyword.

### 6. Release the lock

```bash
curl -s "${H[@]}" -X DELETE "$API/locks/$CONV?run_id=run-2026-11-14T15:24:03Z-abc"
```

This returns `{"released":true}`. The lock also expires on its own after `ttl_seconds`.

## Follow-ups

```bash
curl -s "${H[@]}" "$API/followups?days=3&stages=qualifying,pitched&limit=50"
```

This returns `{"days","stages","contacts":[<contact>…]}`. These are contacts in those
stages whose last inbound message is older than `days` days. Skipped contacts are left
out, and the oldest come first. Use `last_outbound_at` to see whether you already bumped
them.

## Skips

```bash
curl -s "${H[@]}" $API/skips
curl -s "${H[@]}" -X POST $API/skips -d '{"refs":["@some_friend","1456618667530017"],"reason":"friends and family"}'
```

`GET` returns `{"skips":[{"id","ig_username","ig_user_id","zernio_conversation_id","name","skip_reason"}]}`.
`POST` returns `{"updated","created","results":[{"ref","id","status"}]}`. A ref that
isn't a contact yet is created with `skip: true`. To un-skip someone, send
`PATCH /contacts/:ref {"skip":false}`.

## Lead magnet queue and stats

```bash
curl -s "${H[@]}" "$API/lead-magnets?status=posted,building"
curl -s "${H[@]}" $API/stats
```

- `/lead-magnets` returns `{"statuses","contacts":[<contact>…]}`.
- `/stats` returns:
  `{"stages":{"new":n,"qualifying":n,…,"lost":n},"total":n,"skipped":n,"lead_magnets":{"posted":n,"building":n,"built":n,"sent":n}}`.
  It does not count skipped contacts.

## One-time migration from the files

1. **`bonnie-leads.md`**: for each row, `PUT /contacts/:ref`. Use the conversation id
   from the row (or the IG id) as `:ref`. Map the columns like this:

   ```bash
   curl -s "${H[@]}" -X PUT $API/contacts/6af8aa11bb22cc33dd44ee0f -d '{
     "ig_username":"lead_handle","ig_user_id":"1456618667530017","source":"bonnie_story",
     "industry":"M&A, micro-cap, France","ticket_size":"fee 5-10% of sale price",
     "monthly_revenue":null,"stage":"pitched","pitch":{"offer":"sprint_5k","amount":5000},
     "lead_magnet":{"status":"none"},
     "summary":"<the free-text status history from the row>"}'
   ```

   Turn the free-text status into a `stage` value from the list above. "Lead magnet
   flagged: yes" becomes `lead_magnet.status: "posted"`. Running a `PUT` twice is safe:
   it merges into the same contact.
2. **Skip list**: resolve each hardcoded name (Matthias, Che, Alex Tudorescu, Andrew,
   Hayk, JANSCEND, Anna, Florin, Kamil, Răzvan, Pascu, Georg) to its handle or IG id from
   the Zernio inbox. Then send one `POST /skips` with all of them and
   `"reason":"friends and family"`.
3. Stop reading `state.json` and `bot-sent.log`. "Did I send this?" is now
   `sent_by: "bot"` in the message log.

## Errors

| Status | Meaning |
|---|---|
| `400` | Bad body or query. The response lists the issues. |
| `401` | Bad or missing `x-api-key`. |
| `404` | Unknown contact for that `:ref`. |
| `409` | The lock is held by another run. |
| `500` | Server error. Retry once, then alert Cristian. |
