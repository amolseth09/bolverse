"""Short-lived access tokens and rotating refresh tokens.

- Access token: a signed JWT (HS256), valid BOLVERSE_ACCESS_TOKEN_MINUTES (15). It names the session and
  the device; every request also checks the session row, so logging out or revoking works immediately.
- Refresh token: 32 random bytes, stored only as a hash. Each use returns a new one and retires the old.
  Presenting a retired token again means it was copied: the whole session is revoked.
- Both are bound to the device that signed in (X-Device-Id).
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import timedelta

import jwt

from .config import settings
from .security import _SECRET, hmac_hex, new_token, utcnow

ALGORITHM = "HS256"
ISSUER = "bolverse"
# Two refreshes of the same token within this many seconds (two browser tabs, a retried request) are a
# race, not theft: the second gets "refresh_race" and should re-read the newest token.
REFRESH_RACE_SECONDS = 30


def _key() -> bytes:
    return hmac.new(_SECRET.encode(), b"access-token-key", hashlib.sha256).digest()


class TokenExpired(Exception):
    pass


class TokenInvalid(Exception):
    pass


def make_access(session_id: str, user_id: str, device_id: str) -> tuple[str, int]:
    minutes = max(1, settings.access_token_minutes)
    now = utcnow()
    claims = {"iss": ISSUER, "typ": "access", "sid": session_id, "sub": user_id, "did": device_id,
              "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=minutes)).timestamp())}
    return jwt.encode(claims, _key(), algorithm=ALGORITHM), minutes * 60


def read_access(token: str) -> dict:
    try:
        claims = jwt.decode(token, _key(), algorithms=[ALGORITHM], issuer=ISSUER,
                            options={"require": ["exp", "sid", "sub", "did"]}, leeway=10)
    except jwt.ExpiredSignatureError as exc:
        raise TokenExpired from exc
    except jwt.PyJWTError as exc:
        raise TokenInvalid from exc
    if claims.get("typ") != "access":
        raise TokenInvalid
    return claims


def looks_like_jwt(token: str) -> bool:
    return token.count(".") == 2


def new_refresh() -> tuple[str, str]:
    """(token for the app, hash to store)."""
    token = new_token()
    return token, refresh_hash(token)


def refresh_hash(token: str) -> str:
    return hmac_hex("refresh:" + token)
