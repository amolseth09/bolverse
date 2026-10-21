# Connect: messages not reaching the other person

Date: 21 October 2026. Branch: `fix/connect-auth-otp`.

## How Connect delivers messages

There is no socket layer. Connect uses plain HTTPS:

1. The sender's app posts the message (`POST /connect/{id}/messages`). The server transcribes and
   translates it, then stores it.
2. The recipient's app polls `GET /connect/inbox` every 3 seconds while it is open. A content-free push
   notification wakes it otherwise.
3. The recipient's app confirms what it saved with `POST /connect/ack`.

So the "socket room join" and "listener dropped on reconnect" causes in the brief can't happen here. The
equivalent risks sit in the poll, ack and store steps, and that is where the bug was.

## Reproduction

Script: `backend/tests/repro/repro_connect_loss.py`. It drives the real server and copies the apps' exact
logic from `chats.tsx`: fetch the inbox and chat list, merge with the old `mergeInbox` rules, then ack every
id.

```
cd backend
python tests/repro/repro_connect_loss.py .        # against any checkout of backend/
```

### Steps and results on the code before the fix (commit `41af0da`)

**Scenario 1: the recipient is signed in on two devices (phone and web).**

1. Asha signs in on her phone and in a browser. Rahul sends "Are you coming?".
2. Asha's phone polls, saves it, and acks it.
3. Asha's browser polls and gets nothing. **The message never reaches the browser.**

**Scenario 2: a message arrives for a chat the device hasn't listed yet.**

1. Priya joins Vikram's QR code. Vikram's app fetched its chat list just before the join.
2. Priya's first message arrives in the same poll. It has no `peer`, so the old `mergeInbox` skipped it.
3. The app acked it anyway. **The server deleted it and it was lost for good.**

**Scenario 3: the sender retries after a timeout.**

1. The first send succeeded on the server, but the answer didn't reach the phone (slow network, ngrok).
2. The user tapped Send again. **The other person received the message twice.**

Log excerpt (client lines are the simulated app; HTTP lines are the test client):

```
=== Scenario 1: recipient signed in on two devices (phone + web) ===
GET /connect/inbox 200
POST /connect/ack 200
[client asha-phone] inbox=[1] saved=[1]
GET /connect/inbox 200
[client asha-web] inbox=[] saved=[]
[server] send -> 200 id 3
GET /connect/inbox 200
POST /connect/ack 200
[client asha-phone] inbox=[3] saved=[3]
GET /connect/inbox 200
[client asha-web] inbox=[] saved=[]
RESULT scenario 1: web received = False (expected True)
=== Scenario 2: message for a chat this device hasn't listed yet ===
[server] send -> 200 id 3
GET /connect/inbox 200
[client vikram-phone] SKIP message 3 for unknown chat (acked anyway)
POST /connect/ack 200
GET /connect/inbox 200
RESULT scenario 2: message still on server after ack = False -> lost (expected kept until saved)
=== Scenario 3: sender retries after a timeout ===
RESULT scenario 3: copies delivered = 2 (expected 1)
```

## Root causes

1. **Delete-on-ack was per user, not per device.** The first device to ack deleted the server copy, so any
   other signed-in device (phone and web, or two phones) never saw the message.
2. **Acking what wasn't saved.** The app acked every id in the inbox, including messages it skipped, so
   they were deleted. The phone also acked before its storage write had finished, so closing the app at
   that moment lost the message.
3. **No message identity from the client.** A retry after a lost response created a second message.
   There was also no visible status, so users couldn't tell "still sending" from "lost".
4. **Disconnect deleted undelivered messages.** Anything sent in the last seconds before the other
   person disconnected was silently dropped.

## Fix

**Server** (`backend/app/routes_connect.py`, `models.py`)

- **Client IDs:** each message carries a `client_id` made up by the app. Sending the same one again
  returns the stored message, so there is no duplicate, no second translation, and no second charge
  against the free limit.
- **Per-device delivery:** a new `connect_deliveries` table records one row per message and device. The
  inbox offers a message to each of the recipient's devices until that device acks it. The sender's other
  devices also get a copy (`from_me: true`).
- **Receipts:** the first recipient device to ack sets `delivered_at`. The sender's app reads it through
  the new `POST /connect/receipts`.
- **Every message names the other person** (`peer`), so a device can always file it under the right chat.
- **Retention:** messages are no longer deleted on ack. Delivered ones go after 24 h
  (`BOLVERSE_MESSAGE_KEEP_HOURS`); undelivered ones wait 7 days (`BOLVERSE_UNDELIVERED_KEEP_DAYS`).
  Disconnecting keeps messages that were already sent.
- **Logging:** structured log lines (`connect.send`, `connect.inbox`, `connect.ack`) carry message ids and
  shortened user, device and chat ids. They never contain message text.

**Apps** (`packages/shared/src/chats.ts`, `apps/*/src/lib/chats.tsx`, the Connect screens)

- **Message status:** a message appears at once as **Sending…**, then **Sent ✓** (the server saved it),
  then **Delivered ✓✓** (the other person's device has it). It shows **Not sent** with a **Retry** button
  if it failed.
- **Retries:** automatic, after 1, 2, 4, 8 and 16 s (±20%), only for errors a retry can fix (no
  connection, timeouts, 5xx, 429). Quota and disconnected errors fail straight away.
- **Interrupted sends:** messages still marked "sending" when the app was closed are resent on the next
  start. The phone keeps the recording file, so voice messages are resent too. On the web, a voice
  message is marked "Not sent" after a page reload.
- **Duplicates:** the receiver drops anything it already has, matched by server id or client_id.
- **Ack after save:** the phone acks only after storage reports the write finished; the web app acks only
  after localStorage accepted it.

## Tests

- `backend/tests/test_connect_delivery.py` (pytest, 9 tests): multi-device delivery, re-offer until ack,
  peer on every message, idempotent retry (also checks the free-limit count), invalid client ids, receipts
  (only the sender can read them), copies on the sender's other devices, messages that survive a
  disconnect, and retention rules.
- `packages/shared/tests/chats.test.ts` (`npm test -w @bolverse/shared`, 7 tests): de-duplication,
  unknown chats, the sending → sent → delivered status flow, failed status, retry rules, and backoff with
  give-up.

## Not verified here

Real devices on a real network, push wake-ups, and an app killed during a write. These need a manual test
on two phones; the checklist is in `CHANGELOG.md`.
