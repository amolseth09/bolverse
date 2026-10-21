"""Connect delivery: every message reaches every device of the other person exactly once."""
from __future__ import annotations

from datetime import timedelta

from conftest import login

ASHA, RAHUL = "+919000000001", "+919000000002"


def _chat(c, h):
    return c.get("/connect", headers=h).json()[0]["id"]


def _drain(c, h):
    msgs = c.get("/connect/inbox", headers=h).json()["messages"]
    if msgs:
        c.post("/connect/ack", json={"ids": [m["id"] for m in msgs]}, headers=h)
    return msgs


def test_every_device_of_the_recipient_gets_the_message(client):
    phone, web = login(client, ASHA, "asha-phone-01"), login(client, ASHA, "asha-web-0001")
    rahul = login(client, RAHUL, "rahul-phone-1")
    cid = _chat(client, rahul)
    _drain(client, phone), _drain(client, web)
    r = client.post(f"/connect/{cid}/messages", data={"text": "Are you coming?", "client_id": "msg-aaaaaaaa"}, headers=rahul)
    assert r.status_code == 200 and r.json()["status"] == "sent"
    got_phone, got_web = _drain(client, phone), _drain(client, web)
    assert [m["original"] for m in got_phone] == ["Are you coming?"]
    assert [m["original"] for m in got_web] == ["Are you coming?"]
    assert _drain(client, phone) == [] and _drain(client, web) == []


def test_message_is_offered_again_until_this_device_confirms(client):
    asha, rahul = login(client, ASHA, "asha-phone-02"), login(client, RAHUL, "rahul-phone-2")
    cid = _chat(client, rahul)
    _drain(client, asha)
    client.post(f"/connect/{cid}/messages", data={"text": "one"}, headers=rahul)
    first = client.get("/connect/inbox", headers=asha).json()["messages"]
    again = client.get("/connect/inbox", headers=asha).json()["messages"]  # app crashed before saving
    assert [m["id"] for m in first] == [m["id"] for m in again]
    client.post("/connect/ack", json={"ids": [first[0]["id"]]}, headers=rahul)  # not his to confirm
    assert client.get("/connect/inbox", headers=asha).json()["messages"]


def test_every_message_names_the_other_person(client):
    asha, rahul = login(client, ASHA, "asha-phone-03"), login(client, RAHUL, "rahul-phone-3")
    cid = _chat(client, rahul)
    _drain(client, asha)
    client.post(f"/connect/{cid}/messages", data={"text": "hello"}, headers=rahul)
    msg = client.get("/connect/inbox", headers=asha).json()["messages"][0]
    assert msg["peer"]["name"] == "Rahul Mehta" and msg["connection_id"] == cid


def test_retry_with_same_client_id_does_not_duplicate(client):
    asha, rahul = login(client, ASHA, "asha-phone-04"), login(client, RAHUL, "rahul-phone-4")
    cid = _chat(client, rahul)
    _drain(client, asha)
    from app.db import SessionLocal
    from app.models import User

    def used():
        with SessionLocal() as db:
            return db.query(User).filter(User.name_enc.isnot(None)).all() and next(
                u.translations_used for u in db.query(User).all() if u.name == "Rahul Mehta")

    before = used()
    a = client.post(f"/connect/{cid}/messages", data={"text": "Call me", "client_id": "retry-12345678"}, headers=rahul).json()
    b = client.post(f"/connect/{cid}/messages", data={"text": "Call me", "client_id": "retry-12345678"}, headers=rahul).json()
    assert a["id"] == b["id"] and b["client_id"] == "retry-12345678"
    assert [m["original"] for m in _drain(client, asha)] == ["Call me"]
    assert used() == before + 1  # charged once


def test_bad_client_id_rejected(client):
    rahul = login(client, RAHUL, "rahul-phone-5")
    cid = _chat(client, rahul)
    r = client.post(f"/connect/{cid}/messages", data={"text": "x", "client_id": "../../etc"}, headers=rahul)
    assert r.status_code == 422


def test_sender_sees_delivered_after_recipient_confirms(client):
    asha, rahul = login(client, ASHA, "asha-phone-06"), login(client, RAHUL, "rahul-phone-6")
    cid = _chat(client, rahul)
    _drain(client, asha)
    sent = client.post(f"/connect/{cid}/messages", data={"text": "ping"}, headers=rahul).json()
    assert client.post("/connect/receipts", json={"ids": [sent["id"]]}, headers=rahul).json()["delivered"] == []
    _drain(client, asha)
    delivered = client.post("/connect/receipts", json={"ids": [sent["id"]]}, headers=rahul).json()["delivered"]
    assert [d["id"] for d in delivered] == [sent["id"]]
    # Asha can't read Rahul's receipts
    assert client.post("/connect/receipts", json={"ids": [sent["id"]]}, headers=asha).json()["delivered"] == []


def test_senders_other_device_gets_a_copy(client):
    rahul_phone, rahul_web = login(client, RAHUL, "rahul-phone-7"), login(client, RAHUL, "rahul-web-007")
    cid = _chat(client, rahul_phone)
    _drain(client, rahul_web), _drain(client, rahul_phone)
    client.post(f"/connect/{cid}/messages", data={"text": "from my phone"}, headers=rahul_phone)
    copies = _drain(client, rahul_web)
    assert [(m["original"], m["from_me"]) for m in copies] == [("from my phone", True)]
    assert _drain(client, rahul_phone) == []  # the sending device already has it


def test_messages_sent_before_disconnect_still_arrive(client):
    asha, rahul = login(client, ASHA, "asha-phone-08"), login(client, RAHUL, "rahul-phone-8")
    cid = _chat(client, rahul)
    _drain(client, asha)
    client.post(f"/connect/{cid}/messages", data={"text": "last words"}, headers=rahul)
    client.post(f"/connect/{cid}/disconnect", headers=rahul)
    assert [m["kind"] for m in _drain(client, asha)] == ["text", "ended"]


def test_cleanup_keeps_undelivered_and_drops_old_delivered(client):
    from app.config import settings
    from app.db import SessionLocal
    from app.models import ConnectMessage
    from app.routes_connect import _cleanup
    from app.security import utcnow

    asha, rahul = login(client, ASHA, "asha-phone-09"), login(client, RAHUL, "rahul-phone-9")
    cid = _chat(client, rahul)
    _drain(client, asha)
    old_delivered = client.post(f"/connect/{cid}/messages", data={"text": "a"}, headers=rahul).json()["id"]
    _drain(client, asha)
    waiting = client.post(f"/connect/{cid}/messages", data={"text": "b"}, headers=rahul).json()["id"]
    with SessionLocal() as db:
        long_ago = utcnow() - timedelta(hours=settings.message_keep_hours + 1)
        for mid in (old_delivered, waiting):
            db.get(ConnectMessage, mid).created_at = long_ago
        db.commit()
        _cleanup(db)
        db.commit()
        assert db.get(ConnectMessage, old_delivered) is None
        assert db.get(ConnectMessage, waiting) is not None
