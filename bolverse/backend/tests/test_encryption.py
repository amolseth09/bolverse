"""Encryption at rest and TLS-only transport."""
from __future__ import annotations

import base64
import os

import pytest
from sqlalchemy import text

from conftest import login

ASHA, RAHUL = "+919000000001", "+919000000002"


def test_personal_fields_are_encrypted_in_the_database(client):
    from app.db import engine

    login(client, ASHA, "asha-enc-0001")
    with engine.connect() as conn:
        row = conn.execute(text("SELECT phone, phone_enc, name, name_enc, dob, dob_enc FROM users")).mappings().first()
    assert not row["phone"].startswith("+") and row["phone"].startswith("h") and len(row["phone"]) == 20
    for col in ("phone_enc", "name_enc", "dob_enc"):
        assert row[col].startswith("v1."), col
    assert row["name"] == ""
    assert str(row["dob"]).startswith("1900-01-01")


def test_connect_text_is_encrypted_in_the_database(client):
    from app.db import engine

    rahul = login(client, RAHUL, "rahul-enc-001")
    cid = client.get("/connect", headers=rahul).json()[0]["id"]
    client.post(f"/connect/{cid}/messages", data={"text": "my secret plan"}, headers=rahul)
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT original, translation FROM connect_messages")).all()
    assert rows and all(o.startswith("v1.") and t.startswith("v1.") for o, t in rows)
    assert not any("secret" in o for o, _ in rows)


def test_rows_from_older_versions_are_encrypted_on_upgrade(client):
    from app.db import _encrypt_legacy_rows, engine
    from app.crypto import phone_key

    with engine.begin() as conn:
        conn.execute(text("INSERT INTO users (id, phone, name, dob, country, gender, voice_gender, language, "
                          "translations_used, translations_today, blocked, created_at, phone_enc, name_enc, dob_enc) "
                          "VALUES ('legacyuser000000000000000000001', '+14155550100', 'Old Timer', '1980-05-06', 'US', "
                          "'male', 'male', 'en-US', 0, 0, false, '2025-01-01 00:00:00', '', '', '')"))
    _encrypt_legacy_rows()
    with engine.connect() as conn:
        row = conn.execute(text("SELECT phone, phone_enc, name, name_enc FROM users WHERE id='legacyuser000000000000000000001'")).mappings().one()
    assert row["phone"] == phone_key("+14155550100") and row["phone_enc"].startswith("v1.")
    assert row["name"] == "" and row["name_enc"].startswith("v1.")
    from app.db import SessionLocal
    from app.models import User

    with SessionLocal() as db:
        u = db.get(User, "legacyuser000000000000000000001")
        assert (u.phone, u.name, u.dob.isoformat()) == ("+14155550100", "Old Timer", "1980-05-06")


def test_key_rotation_keeps_old_values_readable(monkeypatch):
    from app import crypto
    from app.config import settings

    old_key = base64.b64encode(os.urandom(32)).decode()
    new_key = base64.b64encode(os.urandom(32)).decode()
    monkeypatch.setattr(crypto, "settings", settings.__class__(**{**settings.__dict__, "data_key": old_key}))
    crypto._keys.cache_clear()
    stored = crypto.encrypt("hello")
    monkeypatch.setattr(crypto, "settings", settings.__class__(**{**settings.__dict__, "data_key": new_key,
                                                                    "data_keys_old": [old_key]}))
    crypto._keys.cache_clear()
    assert crypto.decrypt(stored) == "hello"
    assert crypto.encrypt("x").split(".")[1] != stored.split(".")[1]  # new values use the new key
    monkeypatch.undo()
    crypto._keys.cache_clear()


def test_tampered_value_does_not_decrypt():
    from app import crypto

    stored = crypto.encrypt("pay 100")
    head, blob = stored.rsplit(".", 1)
    raw = bytearray(base64.b64decode(blob))
    raw[-1] ^= 1
    with pytest.raises(Exception):
        crypto.decrypt(head + "." + base64.b64encode(bytes(raw)).decode())


def test_plain_http_is_refused_when_https_is_required(client, monkeypatch):
    from app import main

    monkeypatch.setattr(main, "_https_required", lambda: True)
    r = client.get("/languages", headers={"X-Device-Id": "https-test-01"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "https_required"
    r = client.get("/languages", headers={"X-Device-Id": "https-test-01", "X-Forwarded-Proto": "https"})
    assert r.status_code == 200
    assert "max-age" in r.headers["Strict-Transport-Security"]
