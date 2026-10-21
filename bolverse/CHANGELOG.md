# Changelog

## 1.2.0 (21 October 2026), branch `fix/connect-auth-otp`

### 1. Connect: messages reach the other person

- **Root causes**, reproduced with `backend/tests/repro/repro_connect_loss.py`:
  - deleting a message on the first ack meant a second signed-in device never received it;
  - messages for a chat a device didn't know yet were dropped but still acked;
  - retries created duplicates;
  - disconnecting deleted messages that hadn't been delivered yet.
  Full write-up: `docs/connect-delivery-investigation.md`.
- **Server:**
  - **Client IDs:** every message has a client-generated `client_id`, and a retry returns the stored
    message instead of a duplicate.
  - **Delivery:** delivery is tracked per device, so all of a person's devices get every message, and the
    sender's other devices get a copy. `POST /connect/receipts` reports delivery back to the sender.
  - **Retention:** messages are kept until delivered (up to 7 days) instead of being deleted on the first
    ack.
- **Apps:**
  - **Status:** each message shows Sending… / Sent ✓ / Delivered ✓✓ / Not sent, with a Retry button.
  - **Retries and recovery:** automatic retry with backoff (1–16 s); messages left "sending" are resent
    when the app opens again.
  - **Saving:** the app de-duplicates by id or client_id, and acks only after the chat is saved.
- **Tests:** 9 backend tests and 7 shared unit tests.

### 2. Encryption

- **In transit:**
  - TLS only: production refuses plain HTTP and sends HSTS.
  - The Android release build blocks cleartext traffic; iOS ATS is on (local network still allowed).
- **At rest:**
  - Phone numbers, names, dates of birth and Connect message text are encrypted with AES-256-GCM
    (`cryptography` library), with key IDs so keys can be rotated.
  - Phone numbers are found through a keyed blind index.
  - Rows from older versions are encrypted on the first start. Tested on SQLite and PostgreSQL 16.
- **Trust model:** documented in the README and `app/crypto.py`. The server translates, so it sees
  message text while translating: **this is not end-to-end encryption.** Translation stays on the
  server (your decision, 21 Oct 2026).
- `manage.py migrate | reindex-phones | check`.
- **Tests:** 6.

### 3. Male/female voice

- **Root cause:** in the default ("Light") setup the server has one voice per language, mostly male, and
  reported it as `["any"]`. The apps treated "any" as matching every gender, so the chosen gender was
  ignored.
- **Server:** the single voice's pitch is moved to the chosen gender (it keeps its speed), and the
  server now lists both genders.
- **Apps:** they use the server voice only when it lists the chosen gender; otherwise the device voice of
  that gender.
- **Tests:** 15 backend tests (each option through GET and POST /tts, the profile default, a profile
  change, the "their voice" toggle, pitch shifting checked with a pitch detector) and 5 shared tests.

### 4. Login and registration

- **Tokens:**
  - 15-minute access tokens (JWT) and rotating refresh tokens bound to the device.
  - Reusing an old refresh token revokes the session.
  - Logout revokes the session on the server.
  - Phones keep tokens in Keychain/Keystore.
  - Old long-lived tokens are accepted in development only.
- **OTP:** 6 digits, 5 minutes, 5 tries. A new code cancels the old one. 30 s cooldown. Limits per
  number (3 per 10 min, 10 a day) and per IP (10 a minute, 200 a day, and 50 wrong codes per 10 min).
  Codes are stored hashed. Auth events are logged with masked numbers and never with codes.
- **Validation:** name (letters only), date of birth (real, minimum age), phone and language are checked
  on the server and in the apps.
- **Guests:** the apps can be used without logging in, with **50 free translations in total**, counted
  per device and per account. Then the paywall appears; buying needs a login, which the paywall opens.
- **Prices:** ₹50/week and ₹100/month (US$1.99 / US$3.99). The day pass is off (price 0).
- Profile shows the plan, its validity, and the free translations left.
- **Tests:** 25.

### 5. SMS / OTP gateway

- **Providers:** a provider-agnostic `OtpProvider` with `android` (default, your choice), `msg91` (Flow
  API), `twilio_verify` (Twilio issues and checks the code), `twilio` and `console`.
- **Credentials:** read from environment variables only.
- **Development vs production:**
  - `APP_ENV=development` prints codes to the console and enables 10 test accounts with code 123456.
  - In production the test accounts don't exist, 123456 is rejected, and the server refuses to start
    with `console`.
- `manage.py test-sms`; `docs/sms-gateway-setup.md`.

### 6. Deployment

- `docs/deploy-oracle-cloud.md`: Always Free limits checked 21 Oct 2026 (A1 is now 2 OCPUs / 12 GB),
  PostgreSQL on the VM (your choice), venv + systemd, Nginx + Let's Encrypt, migrations, secrets,
  backups, logs, health checks, cost safeguards, and an Autonomous Database appendix.
- Colab notebook: new "AI worker" role, so the Oracle server can use Colab for the models (too heavy for
  the free VM).

### Manual test checklist (real devices)

1. **Two devices, one account.** Sign in as the same user on a phone and in a browser. A message from
   the other person appears on both.
2. **Airplane mode.** Turn airplane mode on, send a message ("Sending…"), turn it off. It changes to
   "Sent ✓", then to "Delivered ✓✓" once the other phone opens Connect.
3. **Retry.** With the server stopped, a message ends as "Not sent". Start the server and tap Retry.
4. **Voices.** Choose Female, then Male, in Profile, and use **Test voice**. Check that the voice changes,
   on web and on the phone.
5. **Guests.** Uninstall, reinstall, tap "Try it first", and use 50 translations. The paywall appears;
   **Log in to get Premium** opens the login.
6. **Blocking.** In the dashboard, block a user. Their next request is refused with "This account has
   been suspended", and they can't refresh their session.
