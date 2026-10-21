"""Sign-in with OTP, sessions with rotating refresh tokens, guests and the paywall, test accounts."""
from __future__ import annotations

import dataclasses
import logging
import time
from datetime import timedelta

import jwt
import pytest
from sqlalchemy import text

from conftest import headers, login

ASHA, RAHUL = "+919000000001", "+919000000002"
REAL = "+919812345678"  # not a test account: goes through the SMS provider


class FakeSms:
    name = "fake"
    issues_own_code = False

    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    def send(self, phone, code):
        self.sent.append((phone, code))


@pytest.fixture(autouse=True)
def _clean_limits():
    from app import ratelimit, sms

    ratelimit.reset()
    yield
    sms._override = None


@pytest.fixture()
def sms_box():
    from app import sms

    box = FakeSms()
    sms._override = box
    return box


def _with_settings(monkeypatch, **changes):
    from app import config, entitlements, routes_auth

    new = dataclasses.replace(config.settings, **changes)
    for mod in (routes_auth, entitlements):
        monkeypatch.setattr(mod, "settings", new)
    return new


# ---------- OTP ----------

def test_code_is_six_digits_and_stored_only_as_a_hash(client, sms_box):
    from app.db import engine

    r = client.post("/auth/otp", json={"phone": REAL}, headers=headers("otp-test-0001"))
    assert r.status_code == 200 and "dev_code" not in r.json()
    phone, code = sms_box.sent[-1]
    assert phone == REAL and len(code) == 6 and code.isdigit()
    with engine.connect() as conn:
        row = conn.execute(text("SELECT phone, code_hash FROM otp_codes ORDER BY id DESC LIMIT 1")).one()
    assert code not in row.code_hash and REAL not in row.phone and len(row.code_hash) == 64


def test_full_registration_then_login(client, sms_box):
    h = headers("otp-test-0002")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    r = client.post("/auth/verify", json={"phone": REAL, "code": sms_box.sent[-1][1]}, headers=h).json()
    assert r["status"] == "new_user"
    r = client.post("/auth/complete", json={"signup_token": r["signup_token"], "name": "Kavya Rao", "dob": "1999-02-03",
                                            "gender": "female", "language": "hi-IN"}, headers=h).json()
    assert r["status"] == "signed_in" and r["access_token"] and r["refresh_token"] and r["expires_in"] == 900
    assert r["account"]["user"]["name"] == "Kavya Rao" and r["account"]["plan"] == "free"
    # login again later: straight in
    client.post("/auth/otp", json={"phone": "+91 98123 45678"}, headers=h)
    r2 = client.post("/auth/verify", json={"phone": REAL, "code": sms_box.sent[-1][1]}, headers=h).json()
    assert r2["status"] == "signed_in"


def test_code_expires_after_five_minutes(client, sms_box):
    from app.db import SessionLocal
    from app.models import OtpCode
    from app.security import utcnow

    h = headers("otp-test-0003")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    with SessionLocal() as db:
        otp = db.query(OtpCode).order_by(OtpCode.id.desc()).first()
        assert abs((otp.expires_at - otp.created_at).total_seconds() - 300) < 2
        otp.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    r = client.post("/auth/verify", json={"phone": REAL, "code": sms_box.sent[-1][1]}, headers=h)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "otp_expired"


def test_five_wrong_tries_lock_the_code(client, sms_box):
    h = headers("otp-test-0004")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    good = sms_box.sent[-1][1]
    wrong = "000000" if good != "000000" else "111111"
    codes = [client.post("/auth/verify", json={"phone": REAL, "code": wrong}, headers=h).json()["detail"]["code"]
             for _ in range(5)]
    assert codes == ["otp_invalid"] * 4 + ["otp_locked"]
    r = client.post("/auth/verify", json={"phone": REAL, "code": good}, headers=h)
    assert r.json()["detail"]["code"] == "otp_locked"


def test_new_code_replaces_the_old_one(client, sms_box):
    h = headers("otp-test-0005")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    first = sms_box.sent[-1][1]
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    second = sms_box.sent[-1][1]
    if first != second:
        assert client.post("/auth/verify", json={"phone": REAL, "code": first}, headers=h).status_code == 400
    assert client.post("/auth/verify", json={"phone": REAL, "code": second}, headers=h).status_code == 200


def test_resend_cooldown_is_30_seconds(client, sms_box, monkeypatch):
    _with_settings(monkeypatch, otp_resend_seconds=30)
    h = headers("otp-test-0006")
    assert client.post("/auth/otp", json={"phone": REAL}, headers=h).status_code == 200
    r = client.post("/auth/otp", json={"phone": REAL}, headers=h)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "otp_cooldown" and 25 <= r.json()["detail"]["retry_in"] <= 30


def test_rate_limits_per_ip_and_per_number(client, sms_box):
    from app.config import settings

    h = headers("otp-test-0007")
    n = settings.otp_ip_per_minute
    numbers = [f"+91981234{i:04d}" for i in range(n + 1)]
    codes = [client.post("/auth/otp", json={"phone": num}, headers=h).status_code for num in numbers]
    assert codes[:n] == [200] * n and codes[n] == 429  # per minute per IP
    from app import ratelimit

    ratelimit.reset()
    same_number = [client.post("/auth/otp", json={"phone": REAL}, headers=headers(f"otp-test-01{i:02d}")).status_code
                   for i in range(4)]
    assert same_number[:3] == [200] * 3 and same_number[3] == 429  # 3 per 10 minutes per number


def test_logs_never_contain_codes_or_full_numbers(client, sms_box, caplog):
    caplog.set_level(logging.DEBUG, logger="bolverse.auth")
    h = headers("otp-test-0008")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    code = sms_box.sent[-1][1]
    client.post("/auth/verify", json={"phone": REAL, "code": "999999" if code != "999999" else "888888"}, headers=h)
    client.post("/auth/verify", json={"phone": REAL, "code": code}, headers=h)
    text_ = caplog.text
    assert "auth.otp_sent" in text_ and "auth.otp_wrong" in text_
    assert REAL not in text_ and "9812345678" not in text_ and code not in text_


def test_bad_input_is_rejected(client):
    h = headers("otp-test-0009")
    assert client.post("/auth/otp", json={"phone": "12"}, headers=h).status_code == 422
    assert client.post("/auth/otp", json={"phone": "+91 99999 abcde"}, headers=h).status_code == 422
    assert client.post("/auth/verify", json={"phone": REAL, "code": "12ab56"}, headers=h).status_code == 422


@pytest.mark.parametrize("field,value,code", [("name", "R2-D2", 422), ("dob", "2099-01-01", 422), ("dob", "2020-01-01", 422)])
def test_signup_details_are_validated(client, sms_box, field, value, code):
    h = headers("otp-test-0010")
    client.post("/auth/otp", json={"phone": REAL}, headers=h)
    token = client.post("/auth/verify", json={"phone": REAL, "code": sms_box.sent[-1][1]}, headers=h).json()["signup_token"]
    body = {"signup_token": token, "name": "Kavya Rao", "dob": "1999-02-03", "gender": "female", "language": "hi-IN", field: value}
    assert client.post("/auth/complete", json=body, headers=h).status_code == code


# ---------- Test accounts ----------

def test_test_accounts_work_in_development(client):
    r = client.post("/auth/otp", json={"phone": ASHA}, headers=headers("otp-test-0011")).json()
    assert r["dev_code"] == "123456"


def test_test_accounts_do_not_work_in_production(client, sms_box, monkeypatch):
    _with_settings(monkeypatch, app_env="production", dev_mode=False)
    h = headers("otp-test-0012")
    r = client.post("/auth/otp", json={"phone": ASHA}, headers=h)
    assert r.status_code == 200 and "dev_code" not in r.json()
    assert sms_box.sent[-1][0] == ASHA  # a real SMS with a random code, like anyone else
    if sms_box.sent[-1][1] != "123456":
        r = client.post("/auth/verify", json={"phone": ASHA, "code": "123456"}, headers=h)
        assert r.status_code == 400


def test_production_refuses_to_start_with_console_sms(monkeypatch):
    from app import config, main

    prod = dataclasses.replace(config.settings, app_env="production", dev_mode=False, sms_provider="console")
    monkeypatch.setattr(main, "settings", prod)
    with pytest.raises(RuntimeError):
        main._startup()


# ---------- Sessions ----------

def _signin(client, phone, device):
    h = headers(device)
    client.post("/auth/otp", json={"phone": phone}, headers=h)
    return client.post("/auth/verify", json={"phone": phone, "code": "123456"}, headers=h).json()


def test_refresh_rotates_and_old_token_stops_working(client):
    s = _signin(client, ASHA, "sess-test-001")
    h = headers("sess-test-001")
    r1 = client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]}, headers=h).json()
    assert r1["refresh_token"] != s["refresh_token"]
    assert client.get("/me", headers=headers("sess-test-001", r1["access_token"])).json()["user"]["name"] == "Asha Verma"
    r2 = client.post("/auth/refresh", json={"refresh_token": r1["refresh_token"]}, headers=h)
    assert r2.status_code == 200


def test_reused_refresh_token_revokes_the_session(client):
    from app.db import SessionLocal
    from app.models import AuthSession

    s = _signin(client, ASHA, "sess-test-002")
    h = headers("sess-test-002")
    newer = client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]}, headers=h).json()
    # within a few seconds it's treated as a harmless race
    r = client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "refresh_race"
    with SessionLocal() as db:  # pretend the rotation happened a while ago
        sess = db.query(AuthSession).filter(AuthSession.device_id == "sess-test-002").one()
        sess.rotated_at -= timedelta(minutes=5)
        db.commit()
    r = client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]}, headers=h)
    assert r.status_code == 401
    # the thief's use killed the session for the real owner too
    assert client.post("/auth/refresh", json={"refresh_token": newer["refresh_token"]}, headers=h).status_code == 401
    assert client.get("/me", headers=headers("sess-test-002", newer["access_token"])).status_code == 401


def test_refresh_token_only_works_on_its_own_device(client):
    s = _signin(client, ASHA, "sess-test-003")
    r = client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]}, headers=headers("other-device-1"))
    assert r.status_code == 401
    assert client.get("/me", headers=headers("other-device-1", s["access_token"])).status_code == 401


def test_expired_access_token_asks_for_refresh(client):
    from app import tokens

    s = _signin(client, ASHA, "sess-test-004")
    claims = jwt.decode(s["access_token"], options={"verify_signature": False})
    claims["exp"] = int(time.time()) - 60
    stale = jwt.encode(claims, tokens._key(), algorithm="HS256")
    r = client.get("/me", headers=headers("sess-test-004", stale))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "token_expired"


def test_logout_revokes_access_and_refresh(client):
    s = _signin(client, ASHA, "sess-test-005")
    h = headers("sess-test-005", s["access_token"])
    assert client.post("/auth/logout", json={"refresh_token": s["refresh_token"]}, headers=h).json()["ok"]
    assert client.get("/me", headers=h).status_code == 401
    assert client.post("/auth/refresh", json={"refresh_token": s["refresh_token"]},
                       headers=headers("sess-test-005")).status_code == 401


def test_refresh_token_is_not_an_access_token(client):
    s = _signin(client, ASHA, "sess-test-006")
    assert client.get("/me", headers=headers("sess-test-006", s["refresh_token"])).status_code == 401


def test_old_long_lived_tokens_refused_when_switched_off(client, monkeypatch):
    from app.db import SessionLocal
    from app.models import AuthSession, User
    from app.crypto import phone_key
    from app.security import hmac_hex, utcnow

    with SessionLocal() as db:
        uid = db.query(User).filter(User.phone_key == phone_key(ASHA)).one().id
        db.add(AuthSession(user_id=uid, kind="legacy", token_hash=hmac_hex("session:oldtoken123"), device_id="legacy-dev-01",
                           expires_at=utcnow() + timedelta(days=30)))
        db.commit()
    assert client.get("/me", headers=headers("legacy-dev-01", "oldtoken123")).status_code == 200
    _with_settings(monkeypatch, allow_legacy_sessions=False)
    assert client.get("/me", headers=headers("legacy-dev-01", "oldtoken123")).status_code == 401


# ---------- Guests, free translations and the paywall ----------

def test_guest_gets_50_free_translations_then_the_paywall(client):
    g = headers("guest-device-01")
    for i in range(50):
        r = client.post("/translate", json={"text": f"hi {i}", "source": "en-US", "target": "hi-IN"}, headers=g)
        assert r.status_code == 200, (i, r.text)
    usage = client.get("/me", headers=g).json()["usage"]
    assert usage["kind"] == "total" and usage["left"] == 0
    r = client.post("/translate", json={"text": "one more", "source": "en-US", "target": "hi-IN"}, headers=g)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "quota_exceeded" and r.json()["detail"]["signup"] is True
    # buying needs a login
    assert client.post("/billing/checkout", json={"plan": "week"}, headers=g).status_code == 401
    # a fresh account on the same device doesn't reset the free uses
    s = _signin(client, ASHA, "guest-device-01")
    r = client.post("/translate", json={"text": "again", "source": "en-US", "target": "hi-IN"},
                    headers=headers("guest-device-01", s["access_token"]))
    assert r.status_code == 402 and r.json()["detail"]["signup"] is False


def test_premium_user_is_unlimited_and_sees_validity(client):
    s = _signin(client, RAHUL, "prem-device-01")
    acct = s["account"]
    assert acct["plan"] == "premium" and acct["subscription"]["valid_until"] and acct["usage"]["kind"] == "unlimited"


def test_prices_follow_the_spec(client):
    prices = client.get("/me", headers={**headers("price-dev-001"), "X-Region": "IN"}).json()["prices"]
    assert [(p["plan"], p["label"]) for p in prices] == [("week", "₹50"), ("month", "₹100")]
    r = client.post("/billing/checkout", json={"plan": "day"},
                    headers=headers("price-dev-002", _signin(client, ASHA, "price-dev-002")["access_token"]))
    assert r.status_code == 422
