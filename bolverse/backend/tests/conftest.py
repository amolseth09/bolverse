"""Shared setup for the pytest suites: a throwaway SQLite database and a stand-in AI engine."""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_DB_DIR = tempfile.mkdtemp(prefix="bolverse-pytest-")
os.environ.update(
    # TEST_DATABASE_URL runs the suites against PostgreSQL, e.g. postgresql+psycopg://user@host/db
    BOLVERSE_DATABASE_URL=os.environ.get("TEST_DATABASE_URL", f"sqlite:///{_DB_DIR}/test.db"), BOLVERSE_SECRET_KEY="test-secret", APP_ENV="development",
    BOLVERSE_OTP_RESEND_SECONDS="0", BOLVERSE_PUBLIC_BASE_URL="http://testserver", BOLVERSE_AI_URL="",
    BOLVERSE_PAYMENT_PROVIDER_INR="dev", BOLVERSE_PAYMENT_PROVIDER_USD="dev", BOLVERSE_SMS_PROVIDER="console",
    BOLVERSE_DASHBOARD_DIR=os.path.join(_DB_DIR, "none"), BOLVERSE_DATA_DIR=_DB_DIR,
)


class FakeAI:
    """Predictable answers; records what it was asked so tests can check what reached the engine."""
    remote = False

    def __init__(self):
        self.spoken: list[tuple[str, str, str | None]] = []

    def transcribe(self, audio, filename, lang, hints):
        return {"text": "I am going to the market", "speaker_gender": "male"}

    def translate(self, text, src, tgt):
        return f"[{tgt.code}] {text}"

    def to_native(self, text, lang):
        return text

    def polish(self, source_text, translation, src, tgt, gender, reader, readings):
        return {"translation": translation, "native_reading": "", "english_reading": ""}

    def speak(self, text, lang, rate, gender):
        self.spoken.append((text, lang.code, gender))
        return (b"RIFF0000WAVEfmt ", gender or "female")

    def voice_options(self, lang):
        return {"available": True, "genders": ["female", "male"]}

    def status(self):
        return {"mode": "test", "device": "cpu", "loaded": {}}

    def preload(self):
        pass


@pytest.fixture()
def fake_ai():
    from app import ai as ai_module

    from app import main

    engine = FakeAI()
    ai_module._engine = engine
    main.ai = engine  # main keeps its own reference
    return engine


@pytest.fixture()
def client(fake_ai):
    from fastapi.testclient import TestClient

    from app import main
    from app.db import Base, engine

    Base.metadata.drop_all(engine)
    with TestClient(main.app) as c:
        yield c


def headers(device: str, token: str | None = None) -> dict:
    h = {"X-Device-Id": device}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def login(c, phone: str, device: str) -> dict:
    """Signs a seeded test user in on a device; returns request headers."""
    r = c.post("/auth/otp", json={"phone": phone}, headers=headers(device))
    assert r.status_code == 200, r.text
    r = c.post("/auth/verify", json={"phone": phone, "code": "123456"}, headers=headers(device))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "signed_in", body
    return headers(device, body.get("access_token") or body["token"])


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    from app import ratelimit

    ratelimit.reset()
    yield
