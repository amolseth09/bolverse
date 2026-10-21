"""Push notifications through Firebase Cloud Messaging (FCM HTTP v1).

Privacy: a push only says "You have a new message on Bolverse". It never carries who sent it or what
they said; the phone fetches the message from this server when it opens. Off unless
BOLVERSE_FCM_SERVICE_ACCOUNT points to a Firebase service-account JSON file.
"""
from __future__ import annotations

import json
import logging
import threading
import time

import httpx
from sqlalchemy import delete, select

from .config import settings
from .db import SessionLocal
from .models import PushToken

log = logging.getLogger("bolverse")
_lock = threading.Lock()
_cache: dict = {"token": None, "exp": 0.0, "project": None, "account": None}


def enabled() -> bool:
    return bool(settings.fcm_service_account)


def _account() -> dict:
    if _cache["account"] is None:
        with open(settings.fcm_service_account, encoding="utf-8") as f:
            _cache["account"] = json.load(f)
    return _cache["account"]


def _access_token() -> tuple[str, str]:
    import jwt  # PyJWT with cryptography

    with _lock:
        if _cache["token"] and _cache["exp"] - 60 > time.time():
            return _cache["token"], _cache["project"]
        acc = _account()
        now = int(time.time())
        assertion = jwt.encode({"iss": acc["client_email"], "scope": "https://www.googleapis.com/auth/firebase.messaging",
                                "aud": acc["token_uri"], "iat": now, "exp": now + 3600},
                               acc["private_key"], algorithm="RS256")
        r = httpx.post(acc["token_uri"], data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                               "assertion": assertion}, timeout=10)
        r.raise_for_status()
        body = r.json()
        _cache.update(token=body["access_token"], exp=now + int(body.get("expires_in", 3600)), project=acc["project_id"])
        return _cache["token"], _cache["project"]


def _send(user_id: str, kind: str, connection_id: str) -> None:
    with SessionLocal() as db:
        tokens = list(db.scalars(select(PushToken.token).where(PushToken.user_id == user_id)))
    if not tokens:
        return
    try:
        access, project = _access_token()
    except Exception as exc:  # misconfigured key file, no network
        log.warning("Push notifications unavailable: %s", exc)
        return
    body = {"joined": "Someone connected with you on Bolverse.", "ended": "A Bolverse chat was disconnected."}.get(
        kind, "You have a new message on Bolverse.")
    for token in tokens:
        msg = {"message": {"token": token,
                           "notification": {"title": "Bolverse", "body": body},
                           "data": {"type": kind, "connection_id": connection_id},
                           "android": {"priority": "high", "notification": {"channel_id": "messages"}}}}
        try:
            r = httpx.post(f"https://fcm.googleapis.com/v1/projects/{project}/messages:send",
                           headers={"Authorization": f"Bearer {access}"}, json=msg, timeout=10)
            if r.status_code in (400, 404) and ("UNREGISTERED" in r.text or "INVALID_ARGUMENT" in r.text):
                with SessionLocal() as db:  # the app was uninstalled or the token changed
                    db.execute(delete(PushToken).where(PushToken.token == token))
                    db.commit()
        except httpx.HTTPError as exc:
            log.warning("Push send failed: %s", exc)


def notify(user_id: str, kind: str, connection_id: str) -> None:
    """Fire and forget, so a slow push service never delays the chat."""
    if enabled():
        threading.Thread(target=_send, args=(user_id, kind, connection_id), daemon=True).start()
