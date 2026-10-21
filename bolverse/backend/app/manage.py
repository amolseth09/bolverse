"""Maintenance commands.

    python -m app.manage migrate          create missing tables, columns and indexes; encrypt old rows
    python -m app.manage reindex-phones   after rotating BOLVERSE_DATA_KEY: rebuild the phone-number index
    python -m app.manage check            print the settings that matter for production, without secrets
    python -m app.manage test-sms +9198xxxxxxxx   send a test code with the configured SMS provider
"""
from __future__ import annotations

import sys

from .config import settings


def migrate() -> None:
    from .db import init_db

    init_db()
    print("Database is up to date.")


def reindex_phones() -> None:
    from .crypto import phone_key
    from .db import SessionLocal
    from .models import User

    n = 0
    with SessionLocal() as db:
        for user in db.query(User):
            if user.phone and user.phone_key != phone_key(user.phone):
                user.phone = user.phone  # re-encrypts with the current key and recomputes the index
                n += 1
        db.commit()
    print(f"Re-indexed {n} phone numbers.")


def check() -> int:
    problems = []
    if settings.app_env == "production":
        if not (settings.data_key or settings.secret_key):
            problems.append("BOLVERSE_DATA_KEY is not set")
        if settings.sms_provider == "console":
            problems.append("BOLVERSE_SMS_PROVIDER=console sends no SMS")
        if settings.database_url.startswith("sqlite"):
            problems.append("SQLite in production: use PostgreSQL")
        if "*" in settings.cors_origins:
            problems.append("BOLVERSE_CORS_ORIGINS=* (list your web app's address instead)")
    print(f"APP_ENV={settings.app_env}  test accounts={'on' if settings.dev_mode and settings.seed_test_users else 'off'}  "
          f"SMS={settings.sms_provider}  database={settings.database_url.split(':', 1)[0]}  "
          f"encryption={'on' if settings.encrypt_at_rest else 'OFF'}  key={'set' if settings.data_key else 'derived'}")
    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


def test_sms(number: str) -> int:
    from .security import mask_phone, new_otp, normalize_phone
    from .sms import SmsError, deliver, get_provider

    try:
        phone, _ = normalize_phone(number)
    except ValueError:
        print("Not a valid number. Include the country code, e.g. +919812345678.")
        return 2
    provider = get_provider()
    code = None if provider.issues_own_code else new_otp()
    try:
        deliver(phone, code)
    except SmsError as exc:
        print(f"FAILED via {provider.name}: {exc}. See docs/sms-gateway-setup.md, 'Common errors'.")
        return 1
    print(f"Sent via {provider.name} to {mask_phone(phone)}" + (f". The code in the SMS should be {code}." if code else "."))
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "migrate":
        migrate()
    elif cmd == "reindex-phones":
        reindex_phones()
    elif cmd == "check":
        sys.exit(check())
    elif cmd == "test-sms" and len(sys.argv) > 2:
        sys.exit(test_sms(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
