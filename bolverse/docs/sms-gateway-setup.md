# SMS one-time codes: setup guide

Bolverse signs people in with a 6-digit code sent by SMS. The provider is chosen with one environment
variable, and every provider sits behind the same small interface (`backend/app/sms.py`), so switching
later is a configuration change, not a code change.

| `BOLVERSE_SMS_PROVIDER` | What it is | Cost (India) | Paperwork | When to use |
|---|---|---|---|---|
| `console` | Prints the code in the server log, sends nothing | Free | None | Development only. **The server refuses to start with it when `APP_ENV=production`.** |
| `android` (default for launch) | [SMS Gateway for Android](https://docs.sms-gate.app/): your own Android phone and SIM send the SMS | Your mobile plan (often unlimited SMS) | None | Launch and the first few hundred users |
| `msg91` | MSG91 Flow API | About ₹0.13–0.15 per SMS + 18% GST | DLT registration (days) | Growing in India |
| `twilio_verify` | Twilio Verify: Twilio makes, sends and checks the code | Several times MSG91 | Twilio account | Mostly international users, or to avoid DLT paperwork |
| `twilio` | Plain Twilio SMS with Bolverse's own code | High in India | DLT for domestic routes | Kept for older setups |

Prices and rules were checked on **21 October 2026** (sources at the end). They change, so recheck before
you sign up.

> **Decision kept open for you:** the brief asked me to recommend MSG91 but not to choose an account for
> you. The code ships with `android` as the default (your choice on 21 Oct 2026), with MSG91 and Twilio
> Verify ready to switch on. Nothing in the code has signed up for anything.

## Rules that apply to every provider

- Codes: 6 digits, valid 5 minutes (`BOLVERSE_OTP_TTL_SECONDS=300`), 5 wrong tries per code. Asking for a
  new code cancels the old one.
- Limits:
  - 30 s between codes for one number (`BOLVERSE_OTP_RESEND_SECONDS`).
  - Per number: 3 codes per 10 minutes, and `BOLVERSE_OTP_DAILY_LIMIT` (10) per day.
  - Per network (IP): `BOLVERSE_OTP_IP_PER_MINUTE` (10) per minute and `BOLVERSE_OTP_IP_DAILY` (200) per
    day. These are generous because Indian mobile networks put many people behind one IP (CGNAT).
- Codes are stored only as a keyed hash; phone numbers only as a blind index plus an encrypted copy.
- Logs show masked numbers (`+91 •••••• 3210`) and never the code. The one exception is the `console`
  provider, which prints the code in development on purpose.

## Development and test accounts

```
APP_ENV=development
BOLVERSE_SMS_PROVIDER=console
BOLVERSE_SEED_TEST_USERS=true
```

- On startup the server creates dummy users. Five of them, **+91 90000 00001 to 00005**, plus five more
  listed in `backend/app/seed.py`, all sign in with the fixed code **123456**.
- In development the app also shows the code on screen (`dev_code`).
- With `APP_ENV=production`, none of this works:
  - No test users are created.
  - The fixed code is rejected. Those numbers get a normal random code, like anyone else.
  - `dev_code` is never returned.
  - The server refuses to start with `console`.
- `tests/test_auth_otp.py` checks all of this.

## Option 1: SMS Gateway for Android (default)

You need a spare Android phone with a SIM that has an SMS pack. Keep it plugged in and on Wi-Fi.

1. **Install the app.** Install **SMS Gateway for Android** on the phone. Get it from GitHub releases or
   F-Droid (search "android-sms-gateway"), and allow it to send SMS.
2. **Turn on the cloud server.** Open the app, switch on **Cloud server**, then tap **Offline** so it
   changes to **Online**. A username and password appear in the Cloud server section. You can also see
   them at dashboard.sms-gate.app.
3. **Set the server variables:**
   ```
   BOLVERSE_SMS_PROVIDER=android
   SMSGATE_URL=https://api.sms-gate.app/3rdparty/v1/messages
   SMSGATE_USERNAME=<from the app>
   SMSGATE_PASSWORD=<from the app>
   ```
4. **Send a test.** On the server, from the `backend` folder:
   ```
   python -m app.manage test-sms +91XXXXXXXXXX
   ```
   The phone sends it within a few seconds. The command prints the code the SMS should contain.

Notes:

- **Privacy:** messages pass through the developer's public relay. For full privacy, run their private
  server (docs.sms-gate.app, "Private server"), or use local mode with the phone on the same network as
  the server. Set `SMSGATE_URL` to match.
- **Volume limits:** Android and your operator limit bulk sending (many plans cap at about 100 SMS a
  day). This is fine at launch. Move to MSG91 when sign-ups grow.
- **Sender:** SMS sent this way come from your personal number, not a brand name.

## Option 2: MSG91 (India, at scale)

MSG91 is the recommended long-term provider for India: cheapest per SMS, Indian support, and a
straightforward DLT setup. Every commercial SMS to an Indian number must use a DLT-registered business
(entity), sender ID (header) and message template, and approval takes a few days. Start early.

### A. DLT registration (on a telecom DLT portal, not MSG91)

1. **Register the business (entity).** Use a DLT portal run by an operator, such as Jio (TrueConnect),
   Airtel, Vodafone Idea (VILPower) or SmartPing. Upload your PAN, GST/incorporation proof and an
   authorisation letter, and pay the portal's one-time fee. You get an **Entity ID (PE ID)**.
2. **Register a header (sender ID).** Choose a 6-letter header such as `BOLVRS`, of type "Transactional",
   and wait for approval.
3. **Register a content template**, category "Transactional / OTP", for example:
   `{#var#} is your Bolverse code. It expires in 5 minutes. Don't share it with anyone.`
   After approval you get a **Template ID** (a long number).

### B. MSG91 account

4. **Sign up and get the key.** Sign up at msg91.com and complete KYC. Under **API → Authkey**, create
   an **auth key**.
5. **Add your DLT details.** In the SMS section, add your header and map it to your **PE ID**. Then
   create a template (Flow) with the same text and map it to the DLT **Template ID**. In the MSG91 text,
   write the variable as `##otp##`. The MSG91 template has its own **template ID**, and that's the one
   Bolverse needs.
6. **Set the server variables:**
   ```
   BOLVERSE_SMS_PROVIDER=msg91
   MSG91_AUTH_KEY=<auth key>
   MSG91_TEMPLATE_ID=<MSG91 template/flow id>
   MSG91_OTP_VAR=otp            # the variable name in your template (##otp##)
   ```
7. **Send a test:** `python -m app.manage test-sms +91XXXXXXXXXX`. Check MSG91 **Reports** for the
   delivery status.

## Option 3: Twilio Verify (second adapter)

Twilio Verify generates, sends and checks the code itself. Bolverse then stores no code at all; it only
keeps the attempt counter and the rate limits.

1. **Sign up and get credentials.** Sign up at twilio.com and upgrade from trial to send to any number.
   Copy the **Account SID** and **Auth Token**.
2. **Create a Verify service.** Go to **Verify → Services → Create**, name it "Bolverse", set a 6-digit
   code length and the SMS channel. Copy the **Service SID** (it starts with `VA`).
3. **Set the server variables:**
   ```
   BOLVERSE_SMS_PROVIDER=twilio_verify
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_VERIFY_SERVICE_SID=VA...
   ```
4. **Test** with `python -m app.manage test-sms +1XXXXXXXXXX`. For Verify, the code comes from Twilio,
   so the command doesn't print it.

**India:** Twilio's India guidelines describe two routes:

- **International:** no DLT needed, higher price, and the sender shows as a random number.
- **Domestic:** your own DLT entity and header first, about 10 business days.

The guidelines don't say how Verify traffic is routed. Ask Twilio support before relying on it for
Indian users.

## Keeping credentials safe

- Put credentials only in environment variables: the server's `.env` file (mode 600, never committed;
  `.gitignore` excludes it) or the systemd `EnvironmentFile`. The code never reads keys from anywhere
  else.
- Run `python -m app.manage check` before going live. It flags `console` in production, a missing data
  key, SQLite in production and an open CORS setting.

## Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| App says "We couldn't send the SMS" | The provider rejected the request | Run `python -m app.manage test-sms` on the server and read the log line `auth.sms_failed` |
| `SMSGATE_USERNAME and SMSGATE_PASSWORD are not set` | Missing variables | Copy them from the app's Cloud server section |
| Android gateway: the request succeeds but no SMS arrives | Phone offline, app killed by battery saver, or no SMS balance | Keep the app open, exclude it from battery optimisation, check the SIM's SMS pack |
| MSG91 `type: error`, "template not approved / DLT" | DLT template or header not mapped | Map the PE ID to the header and the DLT template ID to the MSG91 template |
| MSG91 delivers only some numbers | Template text differs from the DLT-approved text | The text must match exactly, apart from the variable |
| Twilio 401 | Wrong SID or token | Use the live (not test) credentials |
| Twilio 60200 / 60203 | Invalid number, or too many attempts for it | The number needs `+` and the country code; wait before retrying |
| `otp_cooldown` / `otp_daily_limit` / `rate_limited` | Limits working as intended | Wait; adjust the `BOLVERSE_OTP_*` variables if real users hit them |
| Server won't start: "needs a real SMS provider" | `APP_ENV=production` with `console` | Choose `android`, `msg91` or `twilio_verify` |

## Sources (checked 21 October 2026)

- SMS Gateway for Android, public cloud server: https://docs.sms-gate.app/getting-started/public-cloud-server
- MSG91 DLT step-by-step: https://msg91.com/help/dlt-registration-in-india/step-by-step-guide-to-implement-dlt-in-sms
- MSG91, map a DLT template to a Flow: https://msg91.com/help/dlt-registration-in-india/map-approved-dlt-template-id-with-respective-flow-id-on-msg91-panel
- Twilio India SMS guidelines: https://www.twilio.com/en-us/guidelines/in/sms
- SMS OTP prices in India (October 2026): https://signops.dev/blog/sms-otp-cost-india/
