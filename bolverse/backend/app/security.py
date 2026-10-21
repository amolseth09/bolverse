"""Hashing, tokens, one-time codes and phone numbers."""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timezone

import phonenumbers

from .config import settings

log = logging.getLogger("bolverse")

_SECRET = settings.secret_key
if not _SECRET:
    _SECRET = secrets.token_hex(32)
    log.warning("BOLVERSE_SECRET_KEY is not set: using a random key, so everyone is signed out on restart.")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hmac_hex(value: str) -> str:
    return hmac.new(_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


def new_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def new_token() -> str:
    return secrets.token_urlsafe(32)


def sign(value: str) -> str:
    """Short signature for links opened in a browser (payment pages)."""
    return hmac_hex("link:" + value)[:32]


def normalize_phone(raw: str) -> tuple[str, str]:
    """Returns (E.164 number, ISO country code) or raises ValueError."""
    try:
        num = phonenumbers.parse(raw.strip(), None)
    except phonenumbers.NumberParseException as exc:
        raise ValueError(str(exc)) from exc
    if not phonenumbers.is_valid_number(num):
        raise ValueError("invalid number")
    return phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164), phonenumbers.region_code_for_number(num) or ""


def mask_phone(e164: str) -> str:
    """+919876543210 -> +91 •••••• 3210 (country code guessed as the first 1 to 3 digits)."""
    if len(e164) <= 8:
        return e164
    try:
        num = phonenumbers.parse(e164, None)
        cc = f"+{num.country_code}"
    except phonenumbers.NumberParseException:
        cc = e164[:3]
    return f"{cc} {'•' * max(2, len(e164) - len(cc) - 4)} {e164[-4:]}"


def make_signup_token(phone: str, ttl_seconds: int = 900) -> str:
    """Proof that this phone number was just verified, valid for 15 minutes, for completing sign-up."""
    import base64
    import time

    payload = f"{phone}|{int(time.time()) + ttl_seconds}"
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return f"{body}.{hmac_hex('signup:' + payload)[:40]}"


def read_signup_token(token: str) -> str | None:
    import base64
    import time

    try:
        body, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode()
        phone, exp = payload.rsplit("|", 1)
    except (ValueError, UnicodeDecodeError):
        return None
    if not same(hmac_hex("signup:" + payload)[:40], sig) or int(exp) < time.time():
        return None
    return phone
