# Bolverse — Talk with AI in any language

Bolverse speaks for you in 64 languages. Web app (React), Android app (React Native, built in Android Studio),
admin dashboard (React), and a self-hosted Python server with open AI models.

- **Ask:** say or type what you want to say (Hinglish works); get it in any language, with how to read it, spoken aloud.
- **Converse:** two people sharing one phone, each in their own language, with matching male/female wording and voices.
- **Connect:** two people on their own phones. One shows a QR code, the other scans it (or types its 6-letter code).
  Each speaks or types in their own language; the other receives it translated and read aloud, with notifications.
  Either can disconnect; talking again needs a fresh QR code. Messages are deleted from the server as soon as the
  other phone receives them.
- **Login with OTP:** mobile number + SMS code. Free option: SMS Gateway for Android sends codes from your own SIM.
- **Plans:** ₹20/day, ₹100/week, ₹250/month in India; $0.99, $3.99, $9.99 elsewhere. 50 free translations a day.
- **Payments:** direct UPI to your own UPI ID (no gateway fee, you approve the transaction ID in the dashboard),
  and Cashfree (or Razorpay) for cards and international customers. All subscriptions and payments are in the database.
- **Admin dashboard** at `/dashboard`: users, passes, payments and UPI approvals, statistics, audit log, and
  dashboard users with four roles (owner, admin, finance, support).

The full step-by-step guide is the companion Claude Doc: *Bolverse: complete setup, build and hosting guide*.

## Folders

| Path | What it is |
|---|---|
| `backend/app/` | The server (FastAPI). `routes_connect.py` (QR chat), `routes_billing.py` (payments), `routes_admin.py` (dashboard API), `push.py` (notifications), `sms.py` (OTP). |
| `backend/tests/run_tests.py` | End-to-end tests with a stand-in AI: `python tests/run_tests.py --loop 5` |
| `backend/static/dashboard/` | The built dashboard, served at `/dashboard`. |
| `backend/colab/bolverse_server.ipynb` | Runs the server on Google Colab with ngrok. |
| `apps/web/` | Web app. Server address: `apps/web/src/config.ts`. |
| `apps/mobile/` | Android app. Open `apps/mobile/android` in Android Studio. Server address: `apps/mobile/src/config.ts`. |
| `apps/admin/` | Dashboard source. |
| `packages/shared/` | Code shared by the apps: API client, types, languages, chat storage, QR drawing. |

## Try everything on a laptop without a GPU

```bash
cd backend && pip install -r requirements-api.txt
BOLVERSE_AI_DEMO=true BOLVERSE_UPI_ID=test@upi uvicorn app.main:app --port 8000
```

Placeholder translations, real logins, payments (test mode), Connect chats and the dashboard at
http://localhost:8000/dashboard.

## Dummy accounts (test mode only, code 123456)

| Mobile | Who |
|---|---|
| +91 90000 00001 | Asha, Hindi, free (connected to Rahul) |
| +91 90000 00002 | Rahul, Hindi, Premium week |
| +91 90000 00003 | Priya, Malayalam, Premium month |
| +91 90000 00004 | Vikram, Punjabi, expired, daily limit used |
| +91 90000 00005 | Arjun, Tamil, a UPI payment waiting for approval |
| +91 90000 00006 | Meera, Bengali, day pass |
| +91 90000 00007 | Sanjay, blocked |
| +1 202 555 0143 | Emma, English, US prices (connected to Lucía) |
| +34 612 345 678 | Lucía, Spanish, Premium month |
| +971 50 123 4567 | Omar, Arabic |

Dashboard: `owner@bolverse.test / Owner@12345`, `admin@… / Admin@12345`, `finance@… / Finance@12345`,
`support@… / Support@12345`.

## Guides

- `docs/deploy-oracle-cloud.md`: production on Oracle Cloud Always Free (API, PostgreSQL, Nginx, HTTPS, backups)
- `docs/sms-gateway-setup.md`: SMS codes with the Android gateway, MSG91 or Twilio Verify
- `docs/connect-delivery-investigation.md`: how Connect delivers messages, and what was fixed
- `CHANGELOG.md`: what changed in each version

## Tests

```
cd backend && python -m pytest tests                  # API: delivery, OTP/auth, encryption, voices (SQLite)
TEST_DATABASE_URL=postgresql+psycopg://... python -m pytest tests   # the same against PostgreSQL
cd backend && python tests/run_tests.py --loop 3      # end-to-end: payments, dashboard roles, Connect
npm test -w @bolverse/shared                          # app logic: delivery states, retries, token refresh, voices
```

## Privacy and encryption

**What is protected**

- **In transit:** TLS only. In production (`APP_ENV=production`, or `BOLVERSE_REQUIRE_HTTPS=true`) the
  server refuses plain-HTTP requests and sends HSTS. The Android release build blocks cleartext traffic,
  and the iOS app allows plain HTTP only on the local network.
- **At rest:** phone numbers, names, dates of birth and Connect message text are encrypted in the database
  with AES-256-GCM (`backend/app/crypto.py`, `cryptography` library). Users are looked up by a keyed hash
  of their number, never by the number itself. Rows written by older versions are encrypted
  automatically on the first start.
- **Keys:** set `BOLVERSE_DATA_KEY` (32 random bytes in base64) and keep a copy somewhere other than the
  database backups. Without the key the encrypted data can't be read. To rotate: put the new key in
  `BOLVERSE_DATA_KEY` and the old one in `BOLVERSE_DATA_KEYS_OLD`, then run
  `python -m app.manage reindex-phones`.
- **Recordings:** they are transcribed in memory and never stored. Ask and Talk history stays on the
  device. Connect messages are kept on the server only until they are delivered (24 h after delivery, at
  most 7 days if never delivered).

**What this is not: end-to-end encryption.** Bolverse translates on its own server, so the server has to
read each message while it translates it (Connect, Ask and Talk alike). The encryption above protects
stored copies: database files, backups, a leaked dump. It does not hide content from whoever runs the
server. True end-to-end encryption would need translation to run on the phone, which current models
can't do well there. That choice (server translation, honestly described) was made on 21 Oct 2026; if it
changes, the translation path in `routes_connect.py` is the place to start.

## Licences to check before a commercial launch

NLLB-200 and MMS-TTS are licensed for non-commercial use only; set `BOLVERSE_TRANSLATION_BACKEND=llm` for
commercial use. Google Play requires Play Billing for subscriptions bought inside an app distributed through the
Play Store. Publish a privacy policy and offer account deletion.
