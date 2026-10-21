"""Runtime settings, read once from environment variables (see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: bool) -> bool:
    return _env(name, str(default)).lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default_factory=lambda: _env("BOLVERSE_API_KEY", ""))
    cors_origins: list[str] = field(
        default_factory=lambda: [o.strip() for o in _env("BOLVERSE_CORS_ORIGINS", "*").split(",") if o.strip()]
    )
    device: str = field(default_factory=lambda: _env("BOLVERSE_DEVICE", "auto"))
    asr_model: str = field(default_factory=lambda: _env("BOLVERSE_ASR_MODEL", "openai/whisper-large-v3-turbo"))
    # faster-whisper (fast, built-in voice detection) | transformers (plain pipeline). faster falls back automatically.
    asr_engine: str = field(default_factory=lambda: _env("BOLVERSE_ASR_ENGINE", "faster"))
    fast_asr_model: str = field(default_factory=lambda: _env("BOLVERSE_FAST_ASR_MODEL", ""))  # empty = match asr_model
    asr_beam: int = field(default_factory=lambda: int(_env("BOLVERSE_ASR_BEAM", "5")))
    # AI4Bharat IndicConformer for Indian languages (falls back to Whisper if it can't load)
    indic_asr: bool = field(default_factory=lambda: _bool("BOLVERSE_INDIC_ASR", True))
    indic_asr_model: str = field(default_factory=lambda: _env("BOLVERSE_INDIC_ASR_MODEL", "ai4bharat/indic-conformer-600m-multilingual"))
    # Clean background noise and trim silence before recognition
    denoise: bool = field(default_factory=lambda: _bool("BOLVERSE_DENOISE", True))
    # Separate voice worker (Kokoro + Indic Parler-TTS) for male and female voices; empty = off
    voice_worker_url: str = field(default_factory=lambda: _env("BOLVERSE_VOICE_WORKER_URL", "http://127.0.0.1:8001").rstrip("/"))
    translation_backend: str = field(default_factory=lambda: _env("BOLVERSE_TRANSLATION_BACKEND", "nllb"))
    nllb_model: str = field(default_factory=lambda: _env("BOLVERSE_NLLB_MODEL", "facebook/nllb-200-distilled-600M"))
    llm_model: str = field(default_factory=lambda: _env("BOLVERSE_LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct"))
    llm_4bit: bool = field(default_factory=lambda: _bool("BOLVERSE_LLM_4BIT", False))
    tts_enabled: bool = field(default_factory=lambda: _bool("BOLVERSE_TTS_ENABLED", True))
    tts_cache_size: int = field(default_factory=lambda: int(_env("BOLVERSE_TTS_CACHE_SIZE", "4")))
    data_dir: str = field(default_factory=lambda: _env("BOLVERSE_DATA_DIR", "./data"))
    preload: bool = field(default_factory=lambda: _bool("BOLVERSE_PRELOAD", False))
    max_upload_mb: int = field(default_factory=lambda: int(_env("BOLVERSE_MAX_UPLOAD_MB", "15")))

    # ---- Accounts and database ----
    # false = open mode: no login, no limits, no paywall, no database needed.
    accounts_enabled: bool = field(default_factory=lambda: _bool("BOLVERSE_ACCOUNTS_ENABLED", True))
    database_url: str = field(default_factory=lambda: _env("BOLVERSE_DATABASE_URL", "sqlite:///./data/bolverse.db"))
    secret_key: str = field(default_factory=lambda: _env("BOLVERSE_SECRET_KEY", ""))
    public_base_url: str = field(default_factory=lambda: _env("BOLVERSE_PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/"))
    # development | production. Test accounts, codes shown in the app and simulated payments exist only in
    # development, whatever else is set. Defaults to development when BOLVERSE_DEV_MODE is on (older setups).
    app_env: str = field(default_factory=lambda: _env("APP_ENV", _env("BOLVERSE_APP_ENV",
                         "development" if _bool("BOLVERSE_DEV_MODE", True) else "production")).lower())
    dev_mode: bool = field(default_factory=lambda: _env("APP_ENV", _env("BOLVERSE_APP_ENV",
                           "development" if _bool("BOLVERSE_DEV_MODE", True) else "production")).lower() == "development")
    session_days: int = field(default_factory=lambda: int(_env("BOLVERSE_SESSION_DAYS", "90")))  # refresh token lifetime
    access_token_minutes: int = field(default_factory=lambda: int(_env("BOLVERSE_ACCESS_TOKEN_MINUTES", "15")))
    # Long-lived tokens from app versions before 1.2. Defaults: allowed in development, refused in production.
    allow_legacy_sessions: bool = field(default_factory=lambda: _bool("BOLVERSE_ALLOW_LEGACY_SESSIONS",
                                        _env("APP_ENV", _env("BOLVERSE_APP_ENV", "development" if _bool("BOLVERSE_DEV_MODE", True) else "production")).lower() == "development"))
    min_age: int = field(default_factory=lambda: int(_env("BOLVERSE_MIN_AGE", "13")))

    # SMS for one-time codes: console (development only) | android (your own phone and SIM, free) | msg91 |
    # twilio_verify | twilio. See app/sms.py and docs/sms-gateway-setup.md.
    sms_provider: str = field(default_factory=lambda: _env("BOLVERSE_SMS_PROVIDER", "console"))
    # "SMS Gateway for Android" (sms-gate.app): the full send URL, and the username/password shown in its app.
    # Self-hosted private server: https://sms.yourdomain.com/3rdparty/v1/messages ; local mode: http://PHONE_IP:8080/message
    smsgate_url: str = field(default_factory=lambda: _env("SMSGATE_URL", "https://api.sms-gate.app/3rdparty/v1/messages"))
    smsgate_username: str = field(default_factory=lambda: _env("SMSGATE_USERNAME", ""))
    smsgate_password: str = field(default_factory=lambda: _env("SMSGATE_PASSWORD", ""))
    otp_ttl_seconds: int = field(default_factory=lambda: int(_env("BOLVERSE_OTP_TTL_SECONDS", "300")))
    otp_resend_seconds: int = field(default_factory=lambda: int(_env("BOLVERSE_OTP_RESEND_SECONDS", "30")))
    otp_daily_limit: int = field(default_factory=lambda: int(_env("BOLVERSE_OTP_DAILY_LIMIT", "10")))  # per number
    # Per network (IP). Indian mobile networks put many people behind one IP (CGNAT), so these are generous;
    # the per-number limits above are the main protection.
    otp_ip_per_minute: int = field(default_factory=lambda: int(_env("BOLVERSE_OTP_IP_PER_MINUTE", "10")))
    otp_ip_daily: int = field(default_factory=lambda: int(_env("BOLVERSE_OTP_IP_DAILY", "200")))
    verify_ip_per_10min: int = field(default_factory=lambda: int(_env("BOLVERSE_VERIFY_IP_PER_10MIN", "50")))
    msg91_auth_key: str = field(default_factory=lambda: _env("MSG91_AUTH_KEY", ""))
    msg91_template_id: str = field(default_factory=lambda: _env("MSG91_TEMPLATE_ID", ""))
    msg91_otp_var: str = field(default_factory=lambda: _env("MSG91_OTP_VAR", "otp"))
    twilio_account_sid: str = field(default_factory=lambda: _env("TWILIO_ACCOUNT_SID", ""))
    twilio_auth_token: str = field(default_factory=lambda: _env("TWILIO_AUTH_TOKEN", ""))
    twilio_from: str = field(default_factory=lambda: _env("TWILIO_FROM", ""))
    twilio_verify_service_sid: str = field(default_factory=lambda: _env("TWILIO_VERIFY_SERVICE_SID", ""))

    # ---- AI engine location ----
    # Empty: models run inside this server (Colab, a GPU machine). Set it to split the deployment:
    # this server keeps accounts and billing, and sends AI work to app.ai_server (e.g. RunPod serverless).
    # true = no AI models, placeholder translations (try the apps and dashboard without a GPU)
    ai_demo: bool = field(default_factory=lambda: _bool("BOLVERSE_AI_DEMO", False))
    ai_url: str = field(default_factory=lambda: _env("BOLVERSE_AI_URL", "").rstrip("/"))
    ai_auth: str = field(default_factory=lambda: _env("BOLVERSE_AI_AUTH", ""))      # e.g. the RunPod API key
    ai_secret: str = field(default_factory=lambda: _env("BOLVERSE_AI_SECRET", ""))  # shared secret with the AI worker

    # ---- Encryption at rest (see app/crypto.py) ----
    data_key: str = field(default_factory=lambda: _env("BOLVERSE_DATA_KEY", ""))
    data_keys_old: list[str] = field(default_factory=lambda: [k.strip() for k in _env("BOLVERSE_DATA_KEYS_OLD", "").split(",") if k.strip()])
    encrypt_at_rest: bool = field(default_factory=lambda: _bool("BOLVERSE_ENCRYPT_AT_REST", True))
    # Refuse plain-HTTP requests (behind a proxy, X-Forwarded-Proto is checked). Defaults on in production.
    require_https: bool = field(default_factory=lambda: _bool("BOLVERSE_REQUIRE_HTTPS", False))

    # ---- Features ----
    learning_enabled: bool = field(default_factory=lambda: _bool("BOLVERSE_LEARNING_ENABLED", False))

    # ---- Free limits ----
    # Signed-in users get this many translations per day; Premium is unlimited.
    # 0 (default): everyone gets BOLVERSE_FREE_TRANSLATIONS in total (guests too, without logging in), then
    # the paywall. Set a number to give signed-in free users that many per day instead (older behaviour).
    free_translations_per_day: int = field(default_factory=lambda: int(_env("BOLVERSE_FREE_TRANSLATIONS_PER_DAY", "0")))
    timezone: str = field(default_factory=lambda: _env("BOLVERSE_TIMEZONE", "Asia/Kolkata"))  # when the daily limit resets
    free_translations: int = field(default_factory=lambda: int(_env("BOLVERSE_FREE_TRANSLATIONS", "50")))  # in total
    free_units: int = field(default_factory=lambda: int(_env("BOLVERSE_FREE_UNITS", "2")))
    free_course_days: int = field(default_factory=lambda: int(_env("BOLVERSE_FREE_COURSE_DAYS", "2")))
    # Create the test accounts (fixed code 123456) at startup. Defaults to on in dev mode.
    seed_test_users: bool = field(default_factory=lambda: _bool("BOLVERSE_SEED_TEST_USERS", True))  # development only

    # ---- Plans and prices (in paise / cents) ----
    price_inr_day: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_INR_DAY", "0")))         # 0 = no day pass
    price_inr_week: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_INR_WEEK", "5000")))    # Rs 50
    price_inr_month: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_INR_MONTH", "10000")))  # Rs 100
    price_usd_day: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_USD_DAY", "0")))         # 0 = no day pass
    price_usd_week: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_USD_WEEK", "199")))     # $1.99
    price_usd_month: int = field(default_factory=lambda: int(_env("BOLVERSE_PRICE_USD_MONTH", "399")))    # $3.99

    # ---- Payments ----
    # Direct UPI: customers pay your own UPI ID by QR or UPI app (no gateway fee); you confirm the
    # transaction ID in the dashboard. Leave UPI_ID empty to switch it off.
    upi_id: str = field(default_factory=lambda: _env("BOLVERSE_UPI_ID", ""))            # e.g. yourname@okhdfcbank
    upi_payee_name: str = field(default_factory=lambda: _env("BOLVERSE_UPI_PAYEE_NAME", "Bolverse"))
    # Cards (Indian and international) and gateway UPI: cashfree | razorpay | dev (simulated, testing only)
    payment_provider_inr: str = field(default_factory=lambda: _env("BOLVERSE_PAYMENT_PROVIDER_INR", "dev"))
    payment_provider_usd: str = field(default_factory=lambda: _env("BOLVERSE_PAYMENT_PROVIDER_USD", "dev"))
    cashfree_app_id: str = field(default_factory=lambda: _env("CASHFREE_APP_ID", ""))
    cashfree_secret_key: str = field(default_factory=lambda: _env("CASHFREE_SECRET_KEY", ""))
    cashfree_env: str = field(default_factory=lambda: _env("CASHFREE_ENV", "sandbox"))  # sandbox | production
    razorpay_key_id: str = field(default_factory=lambda: _env("RAZORPAY_KEY_ID", ""))
    razorpay_key_secret: str = field(default_factory=lambda: _env("RAZORPAY_KEY_SECRET", ""))
    razorpay_webhook_secret: str = field(default_factory=lambda: _env("RAZORPAY_WEBHOOK_SECRET", ""))

    # ---- Connect (QR chat between two phones) and notifications ----
    invite_minutes: int = field(default_factory=lambda: int(_env("BOLVERSE_INVITE_MINUTES", "10")))
    # Delivered messages are kept this long (so your other signed-in devices can sync them) ...
    message_keep_hours: int = field(default_factory=lambda: int(_env("BOLVERSE_MESSAGE_KEEP_HOURS", "24")))
    # ... and undelivered ones this long, waiting for the other person to come online.
    undelivered_keep_days: int = field(default_factory=lambda: int(_env("BOLVERSE_UNDELIVERED_KEEP_DAYS", "7")))
    # Firebase service-account JSON for push notifications (no message text is ever sent through it).
    fcm_service_account: str = field(default_factory=lambda: _env("BOLVERSE_FCM_SERVICE_ACCOUNT", ""))

    # ---- Admin dashboard ----
    # Creates the first owner account at startup if there are no admins yet.
    admin_email: str = field(default_factory=lambda: _env("BOLVERSE_ADMIN_EMAIL", ""))
    admin_password: str = field(default_factory=lambda: _env("BOLVERSE_ADMIN_PASSWORD", ""))
    admin_session_hours: int = field(default_factory=lambda: int(_env("BOLVERSE_ADMIN_SESSION_HOURS", "12")))
    # Built dashboard and web app, served by this server at /dashboard and / when the folders exist.
    dashboard_dir: str = field(default_factory=lambda: _env("BOLVERSE_DASHBOARD_DIR", "./static/dashboard"))


settings = Settings()
