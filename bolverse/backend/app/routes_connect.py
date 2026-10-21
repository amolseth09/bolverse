"""Connect: two people, each on their own phone, chatting in their own languages.

1. A shows a QR code (POST /connect/invite). It works once, for a few minutes; making a new one cancels
   A's older unused codes.
2. B scans it, or types its short code (POST /connect/join). They are now connected.
3. Either speaks or types (POST /connect/{id}/messages, with a client_id the app makes up). The server
   translates into the other person's language, worded for the sender's gender, stores it (encrypted)
   and answers with the saved message: that answer is the server's acknowledgement. Sending the same
   client_id again (a retry after a timeout) returns the same message instead of a duplicate.
4. Every signed-in device of the recipient, and the sender's other devices, collect it
   (GET /connect/inbox) and confirm each message once saved (POST /connect/ack). Delivery is tracked
   per device, so a phone and a browser signed in to the same account both get every message.
   The sender's app learns "delivered" from POST /connect/receipts.
5. Delivered messages are removed after BOLVERSE_MESSAGE_KEEP_HOURS, undelivered ones after
   BOLVERSE_UNDELIVERED_KEEP_DAYS; the conversation history itself is kept on the phones.
6. Either can disconnect (POST /connect/{id}/disconnect). Talking again needs a fresh QR code.

Delivery is by polling (every few seconds while the app is open) plus a content-free push to wake the
phone; there is no socket to drop, so a reconnect simply resumes from what this device hasn't confirmed.
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from . import push
from .ai import get_ai
from .config import settings
from .db import get_db
from .entitlements import Actor, check_translation_quota, get_actor, problem, record_translation, require_user
from .languages import Language, find
from .models import Connection, ConnectDelivery, ConnectInvite, ConnectMessage, PushToken, User
from .security import hmac_hex, utcnow

log = logging.getLogger("bolverse")
router = APIRouter(tags=["connect"])
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I mix-ups
MAX_ACTIVE = 20


class JoinIn(BaseModel):
    token: str | None = Field(default=None, max_length=200)  # from the QR code
    code: str | None = Field(default=None, max_length=12)    # typed instead


class AckIn(BaseModel):
    ids: list[int] = Field(max_length=500)


class ReceiptsIn(BaseModel):
    ids: list[int] = Field(max_length=500)


CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,40}$")


class PushIn(BaseModel):
    token: str = Field(min_length=10, max_length=300)
    platform: str = Field(default="android", max_length=10)


def _lang(code: str | None) -> Language:
    return find(code or "") or find("en-US")


def _peer_id(conn: Connection, me: str) -> str:
    return conn.user_b if conn.user_a == me else conn.user_a


def _person(user: User) -> dict:
    return {"id": user.id, "name": user.name, "language": user.language or "en-US",
            "gender": user.voice_gender or "female"}


def _mine(db: Session, cid: str, me: str) -> Connection:
    conn = db.get(Connection, cid)
    if conn is None or me not in (conn.user_a, conn.user_b):
        raise problem(404, "not_connected", "This chat doesn't exist.")
    return conn


def _active(conn: Connection) -> None:
    if conn.ended_at is not None:
        raise problem(409, "disconnected", "This chat was disconnected. Scan a new QR code to talk again.")


def _message_out(m: ConnectMessage, me: str | None = None) -> dict:
    from_me = me is not None and m.sender_id == me
    status = ("delivered" if m.delivered_at else "sent") if from_me else None
    return {"id": m.id, "client_id": m.client_id or None, "connection_id": m.connection_id, "kind": m.kind,
            "from_me": from_me, "status": status,
            "original": m.original, "source": m.source_lang, "translation": m.translation, "target": m.target_lang,
            "gender": m.sender_gender or None, "at": m.created_at.isoformat() + "Z"}


def _short(value: str) -> str:
    return (value or "")[:8]


def _cleanup(db: Session) -> None:
    now = utcnow()
    db.execute(delete(ConnectMessage).where(ConnectMessage.delivered_at.is_not(None),
                                            ConnectMessage.created_at < now - timedelta(hours=settings.message_keep_hours)))
    db.execute(delete(ConnectMessage).where(ConnectMessage.created_at < now - timedelta(days=settings.undelivered_keep_days)))
    db.execute(delete(ConnectInvite).where(ConnectInvite.expires_at < now - timedelta(days=1)))


# ---------- QR invites ----------

@router.post("/connect/invite")
def make_invite(db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    now = utcnow()
    # A new QR replaces every earlier unused one, so an old screenshot can't be used to connect.
    db.execute(ConnectInvite.__table__.update()
               .where(ConnectInvite.owner_id == user.id, ConnectInvite.used_at.is_(None),
                      ConnectInvite.cancelled_at.is_(None))
               .values(cancelled_at=now))
    token = secrets.token_urlsafe(24)
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        clash = db.scalar(select(ConnectInvite.id).where(ConnectInvite.code == code, ConnectInvite.used_at.is_(None),
                                                         ConnectInvite.cancelled_at.is_(None),
                                                         ConnectInvite.expires_at > now))
        if not clash:
            break
    expires = now + timedelta(minutes=settings.invite_minutes)
    db.add(ConnectInvite(owner_id=user.id, token_hash=hmac_hex("invite:" + token), code=code, expires_at=expires))
    _cleanup(db)
    db.commit()
    return {"qr": f"bolverse://connect?t={token}", "token": token, "code": code,
            "expires_at": expires.isoformat() + "Z", "expires_in": settings.invite_minutes * 60}


@router.post("/connect/join")
def join(body: JoinIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    now = utcnow()
    token = (body.token or "").strip()
    if token.startswith("bolverse://"):
        token = token.split("t=", 1)[-1]
    q = select(ConnectInvite)
    if token:
        q = q.where(ConnectInvite.token_hash == hmac_hex("invite:" + token))
    elif body.code:
        q = q.where(ConnectInvite.code == body.code.strip().upper().replace(" ", ""),
                    ConnectInvite.used_at.is_(None), ConnectInvite.cancelled_at.is_(None))
    else:
        raise problem(422, "invite_required", "Scan the other person's QR code or type their code.")
    invite = db.scalar(q.order_by(ConnectInvite.created_at.desc()).limit(1))
    if invite is None or invite.cancelled_at is not None:
        raise problem(404, "invite_invalid", "This QR code isn't valid. Ask them to show a new one.")
    if invite.used_at is not None:
        raise problem(410, "invite_used", "This QR code has already been used. Ask them to show a new one.")
    if invite.expires_at <= now:
        raise problem(410, "invite_expired", "This QR code has expired. Ask them to show a new one.")
    if invite.owner_id == user.id:
        raise problem(422, "invite_self", "That's your own QR code. Show it to the other person instead.")
    owner = db.get(User, invite.owner_id)
    if owner is None or owner.blocked:
        raise problem(404, "invite_invalid", "This QR code isn't valid. Ask them to show a new one.")
    count = db.scalar(select(func.count()).select_from(Connection).where(
        Connection.ended_at.is_(None), or_(Connection.user_a == user.id, Connection.user_b == user.id)))
    if count >= MAX_ACTIVE:
        raise problem(429, "too_many_chats", f"You can have up to {MAX_ACTIVE} chats. Disconnect one first.")
    invite.used_at, invite.used_by = now, user.id
    conn = db.scalar(select(Connection).where(Connection.ended_at.is_(None), or_(
        and_(Connection.user_a == owner.id, Connection.user_b == user.id),
        and_(Connection.user_a == user.id, Connection.user_b == owner.id))))
    if conn is None:
        conn = Connection(user_a=owner.id, user_b=user.id)
        db.add(conn)
        db.flush()
    db.add(ConnectMessage(connection_id=conn.id, sender_id=user.id, recipient_id=owner.id, kind="joined",
                          original=user.name, source_lang=user.language or "", target_lang=owner.language or ""))
    db.commit()
    push.notify(owner.id, "joined", conn.id)
    return {"connection": {"id": conn.id, "peer": _person(owner), "since": conn.created_at.isoformat() + "Z"}}


# ---------- Chats ----------

@router.get("/connect")
def my_connections(db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    rows = db.scalars(select(Connection).where(Connection.ended_at.is_(None), or_(
        Connection.user_a == user.id, Connection.user_b == user.id)).order_by(Connection.created_at.desc()))
    out = []
    for conn in rows:
        peer = db.get(User, _peer_id(conn, user.id))
        if peer is None:
            continue
        waiting = db.scalar(select(func.count()).select_from(
            _pending_for_device(user.id, actor.device.id).where(ConnectMessage.connection_id == conn.id).subquery()))
        out.append({"id": conn.id, "peer": _person(peer), "since": conn.created_at.isoformat() + "Z", "waiting": waiting})
    return out


@router.post("/connect/{cid}/messages")
def send(cid: str, text: str | None = Form(None, max_length=1000), audio: UploadFile | None = File(None),
         client_id: str | None = Form(None, max_length=40),
         db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    conn = _mine(db, cid, user.id)
    if client_id is not None and not CLIENT_ID.match(client_id):
        raise problem(422, "invalid_client_id", "This app version sent a bad message ID. Update the app.")
    if client_id:
        # A retry of something we already have (the first answer got lost on the way back): same message.
        existing = db.scalar(select(ConnectMessage).where(ConnectMessage.sender_id == user.id,
                                                          ConnectMessage.client_id == client_id))
        if existing is not None:
            log.info("connect.send duplicate client_id=%s msg=%s chat=%s", _short(client_id), existing.id, _short(cid))
            return _message_out(existing, user.id)
    _active(conn)
    peer = db.get(User, _peer_id(conn, user.id))
    if peer is None or peer.blocked:
        raise problem(409, "disconnected", "This chat was disconnected.")
    check_translation_quota(actor)
    ai = get_ai()
    src, tgt = _lang(user.language), _lang(peer.language)
    kind = "text"
    if audio is not None:
        data = audio.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
        if len(data) > settings.max_upload_mb * 1024 * 1024:
            raise problem(413, "too_large", f"Recording is larger than {settings.max_upload_mb} MB.")
        heard = ai.transcribe(data, audio.filename, src, [])["text"]
        kind = "voice"
    else:
        heard = (text or "").strip()
    if not heard:
        raise problem(422, "nothing_heard", "Nothing was heard. Try again a little closer to the mic.")
    from .services.textutil import is_romanized

    original = ai.to_native(heard, src) if is_romanized(heard, src) else heard
    gender = user.voice_gender or None
    if src.nllb != tgt.nllb:
        translation = ai.translate(original, src, tgt)
        translation = ai.polish(original, translation, src, tgt, gender, None, False)["translation"]
    else:
        translation = original
    msg = ConnectMessage(connection_id=conn.id, sender_id=user.id, sender_device=actor.device.id,
                         client_id=client_id or "", recipient_id=peer.id, kind=kind,
                         original=original, source_lang=src.code, translation=translation, target_lang=tgt.code,
                         sender_gender=gender or "")
    db.add(msg)
    db.commit()
    record_translation(db, actor)
    log.info("connect.send stored msg=%s client_id=%s chat=%s kind=%s from_device=%s", msg.id, _short(client_id or ""),
             _short(cid), kind, _short(actor.device.id))
    push.notify(peer.id, "message", conn.id)
    return _message_out(msg, user.id)


def _pending_for_device(user_id: str, device_id: str):
    """Messages this device hasn't confirmed: sent to this user, or sent by this user from another device."""
    seen = select(ConnectDelivery.message_id).where(ConnectDelivery.device_id == device_id)
    return (select(ConnectMessage)
            .where(or_(ConnectMessage.recipient_id == user_id,
                       and_(ConnectMessage.sender_id == user_id, ConnectMessage.sender_device != device_id,
                            ConnectMessage.kind.in_(("text", "voice")))),
                   ConnectMessage.id.not_in(seen)))


@router.get("/connect/inbox")
def inbox(db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """Everything this device hasn't confirmed yet, across all chats, oldest first. Each message carries
    the other person (`peer`), so a device that doesn't know the chat yet can still file it.
    Confirm with POST /connect/ack once saved; until then it is offered again on every call."""
    user = require_user(actor)
    rows = db.scalars(_pending_for_device(user.id, actor.device.id).order_by(ConnectMessage.id).limit(200)).all()
    people: dict[str, dict | None] = {}
    msgs = []
    for m in rows:
        other = m.recipient_id if m.sender_id == user.id else m.sender_id
        if other not in people:
            person = db.get(User, other)
            people[other] = _person(person) if person else None
        out = _message_out(m, user.id)
        out["peer"] = people[other]
        msgs.append(out)
    if msgs:
        log.info("connect.inbox user=%s device=%s offered=%s", _short(user.id), _short(actor.device.id),
                 [m["id"] for m in msgs][:20])
    return {"messages": msgs}


@router.post("/connect/ack")
def ack(body: AckIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """This device has saved these messages. Records delivery per device; the first device of the
    recipient to confirm marks the message delivered for the sender."""
    user = require_user(actor)
    if not body.ids:
        return {"ok": True, "acked": []}
    now = utcnow()
    mine = db.scalars(_pending_for_device(user.id, actor.device.id).where(ConnectMessage.id.in_(body.ids))).all()
    for m in mine:
        db.add(ConnectDelivery(message_id=m.id, device_id=actor.device.id, at=now))
        if m.recipient_id == user.id and m.delivered_at is None:
            m.delivered_at = now
    db.commit()
    acked = [m.id for m in mine]
    log.info("connect.ack user=%s device=%s acked=%s ignored=%s", _short(user.id), _short(actor.device.id),
             acked[:20], [i for i in body.ids if i not in acked][:20])
    return {"ok": True, "acked": acked}


@router.post("/connect/receipts")
def receipts(body: ReceiptsIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """For messages this user sent: which have reached the other person (at least one of their devices)."""
    user = require_user(actor)
    if not body.ids:
        return {"delivered": []}
    rows = db.execute(select(ConnectMessage.id, ConnectMessage.delivered_at).where(
        ConnectMessage.id.in_(body.ids), ConnectMessage.sender_id == user.id,
        ConnectMessage.delivered_at.is_not(None))).all()
    return {"delivered": [{"id": i, "at": at.isoformat() + "Z"} for i, at in rows]}


@router.post("/connect/{cid}/disconnect")
def disconnect(cid: str, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    conn = _mine(db, cid, user.id)
    if conn.ended_at is None:
        conn.ended_at, conn.ended_by = utcnow(), user.id
        peer_id = _peer_id(conn, user.id)
        # Messages already sent stay and are still delivered (before the "disconnected" notice).
        db.add(ConnectMessage(connection_id=conn.id, sender_id=user.id, recipient_id=peer_id, kind="ended",
                              original=user.name))
        db.commit()
        push.notify(peer_id, "ended", conn.id)
    return {"ok": True}


# ---------- Push notifications ----------

@router.post("/push/register")
def register_push(body: PushIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    row = db.get(PushToken, body.token)
    if row is None:
        db.add(PushToken(token=body.token, user_id=user.id, platform=body.platform))
    else:
        row.user_id, row.platform, row.updated_at = user.id, body.platform, utcnow()
    db.commit()
    return {"ok": True, "enabled": push.enabled()}


@router.post("/push/unregister")
def unregister_push(body: PushIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    require_user(actor)
    db.execute(delete(PushToken).where(PushToken.token == body.token))
    db.commit()
    return {"ok": True}
