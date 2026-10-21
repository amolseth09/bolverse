"""Tables. All timestamps are naive UTC."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .crypto import EncryptedText, phone_key
from .db import Base
from .security import utcnow

LEGACY_DOB = date(1900, 1, 1)  # placeholder kept in the old plain-text column


def _id() -> str:
    return uuid.uuid4().hex


class User(Base):
    """Phone, name and date of birth are encrypted at rest (app/crypto.py). The `phone` column holds a
    keyed hash of the number (a "blind index") so a user can be found by number without storing it in
    the clear; `name` and `dob` columns keep harmless placeholders for databases from older versions."""
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    phone_key: Mapped[str] = mapped_column("phone", String(20), unique=True, index=True)  # crypto.phone_key(e164)
    phone_enc: Mapped[str] = mapped_column(EncryptedText, default="")
    name_legacy: Mapped[str] = mapped_column("name", String(80), default="")
    name_enc: Mapped[str] = mapped_column(EncryptedText, default="")
    dob_legacy: Mapped[date] = mapped_column("dob", Date, default=LEGACY_DOB)
    dob_enc: Mapped[str] = mapped_column(EncryptedText, default="")
    country: Mapped[str] = mapped_column(String(2), default="")  # from the phone number, e.g. IN
    gender: Mapped[str] = mapped_column(String(8), default="")  # male | female | other
    voice_gender: Mapped[str] = mapped_column(String(8), default="female")  # voice and grammar used for the user
    language: Mapped[str] = mapped_column(String(10), default="en-US")  # the user's own language
    translations_used: Mapped[int] = mapped_column(Integer, default=0)  # lifetime total
    translations_day: Mapped[date | None] = mapped_column(Date, nullable=True)
    translations_today: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)  # set from the admin dashboard

    # Plain-value accessors; everything else in the code uses these.
    @property
    def phone(self) -> str:
        return self.phone_enc or ""

    @phone.setter
    def phone(self, e164: str) -> None:
        self.phone_enc = e164
        self.phone_key = phone_key(e164)

    @property
    def name(self) -> str:
        return self.name_enc or self.name_legacy or ""

    @name.setter
    def name(self, value: str) -> None:
        self.name_enc, self.name_legacy = value, ""

    @property
    def dob(self) -> date:
        return date.fromisoformat(self.dob_enc) if self.dob_enc else self.dob_legacy

    @dob.setter
    def dob(self, value: date) -> None:
        self.dob_enc, self.dob_legacy = value.isoformat(), LEGACY_DOB


class Device(Base):
    """An app install. Guests are tracked by device until they sign in."""
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    translations_used: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class OtpCode(Base):
    __tablename__ = "otp_codes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    phone: Mapped[str] = mapped_column(String(20))
    purpose: Mapped[str] = mapped_column(String(10))  # login | register
    code_hash: Mapped[str] = mapped_column(String(64))
    ip: Mapped[str] = mapped_column(String(64), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_otp_phone_created", "phone", "created_at"), Index("ix_otp_ip_created", "ip", "created_at"))


class AuthSession(Base):
    """A signed-in device. kind="refresh": token_hash is the hash of the current refresh token (rotated on
    every use; prev_token_hash catches a stolen, already-used token). Short-lived access tokens name this
    row, so revoking it signs the device out at once. kind="legacy": a long-lived token from app versions
    before 1.2 (accepted only while BOLVERSE_ALLOW_LEGACY_SESSIONS is on)."""
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="legacy")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prev_token_hash: Mapped[str] = mapped_column(String(64), default="", index=True)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_reason: Mapped[str] = mapped_column(String(20), default="")


class Payment(Base):
    """Every purchase attempt. Status: pending -> verifying (UPI ID submitted) -> paid | rejected."""
    __tablename__ = "payments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    plan: Mapped[str] = mapped_column(String(10))  # day | week | month
    currency: Mapped[str] = mapped_column(String(3))  # INR | USD
    amount_minor: Mapped[int] = mapped_column(Integer)  # paise / cents
    provider: Mapped[str] = mapped_column(String(16))  # upi | cashfree | razorpay | dev | admin
    method: Mapped[str] = mapped_column(String(8), default="card")  # upi | card | grant
    provider_ref: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    utr: Mapped[str | None] = mapped_column(String(32), nullable=True, unique=True)  # UPI transaction ID
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    note: Mapped[str] = mapped_column(String(300), default="")
    reviewed_by: Mapped[str | None] = mapped_column(String(32), nullable=True)  # admin id
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Subscription(Base):
    """One row per pass (bought, or granted by an admin). Validity is the latest ends_at."""
    __tablename__ = "subscriptions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    plan: Mapped[str] = mapped_column(String(10))
    starts_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    payment_id: Mapped[str] = mapped_column(ForeignKey("payments.id"), unique=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------- Connect: two phones chatting through a QR code ----------

class ConnectInvite(Base):
    """A one-time QR / code. Making a new one cancels the user's older unused ones."""
    __tablename__ = "connect_invites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    code: Mapped[str] = mapped_column(String(8), index=True)  # short code for typing instead of scanning
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    used_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Connection(Base):
    __tablename__ = "connections"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_a: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)  # showed the QR
    user_b: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)  # scanned it
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_by: Mapped[str | None] = mapped_column(String(32), nullable=True)


class ConnectMessage(Base):
    """A Connect message. Kept until every signed-in device of the recipient (and the sender's other
    devices) has confirmed it, then deleted after BOLVERSE_MESSAGE_KEEP_HOURS; undelivered ones wait
    BOLVERSE_UNDELIVERED_KEEP_DAYS. Text is encrypted at rest. The conversation history itself lives on
    the phones."""
    __tablename__ = "connect_messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    connection_id: Mapped[str] = mapped_column(ForeignKey("connections.id", ondelete="CASCADE"), index=True)
    sender_id: Mapped[str] = mapped_column(String(32))
    sender_device: Mapped[str] = mapped_column(String(64), default="")
    client_id: Mapped[str] = mapped_column(String(40), default="")  # set by the sending app; makes retries safe
    recipient_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="text")  # text | voice | joined | ended
    original: Mapped[str] = mapped_column(EncryptedText, default="")
    source_lang: Mapped[str] = mapped_column(String(10), default="")
    translation: Mapped[str] = mapped_column(EncryptedText, default="")
    target_lang: Mapped[str] = mapped_column(String(10), default="")
    sender_gender: Mapped[str] = mapped_column(String(8), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # first recipient device confirmed
    __table_args__ = (Index("ix_connect_msg_sender_client", "sender_id", "client_id"),)


class ConnectDelivery(Base):
    """One row per (message, device) once that device has saved the message."""
    __tablename__ = "connect_deliveries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("connect_messages.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("message_id", "device_id", name="uq_delivery_message_device"),)


class PushToken(Base):
    __tablename__ = "push_tokens"
    token: Mapped[str] = mapped_column(String(300), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform: Mapped[str] = mapped_column(String(10), default="android")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------- Admin dashboard ----------

class AdminUser(Base):
    __tablename__ = "admin_users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(10))  # owner | admin | finance | support
    password_hash: Mapped[str] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AdminSession(Base):
    __tablename__ = "admin_sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    admin_id: Mapped[str] = mapped_column(ForeignKey("admin_users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditLog(Base):
    """Every change made from the dashboard: who, what, when."""
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    admin_id: Mapped[str] = mapped_column(String(32), index=True)
    admin_email: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(40))
    target: Mapped[str] = mapped_column(String(80), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


# ---------- Learning and personalisation ----------
# owner is "user:<id>" for signed-in users or "device:<id>" for guests; it moves to the user on sign-in.

class VocabTerm(Base):
    """A word the user taught Bolverse (a name, a place), used as a hint when listening."""
    __tablename__ = "vocab_terms"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner: Mapped[str] = mapped_column(String(80), index=True)
    language: Mapped[str] = mapped_column(String(10))
    term: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Correction(Base):
    """A fixed mishearing, kept (only with consent) as training data for future model tuning."""
    __tablename__ = "corrections"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner: Mapped[str] = mapped_column(String(80), index=True)
    language: Mapped[str] = mapped_column(String(10))
    heard: Mapped[str] = mapped_column(Text)
    corrected: Mapped[str] = mapped_column(Text)
    consent: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Enrollment(Base):
    """A learner's course: which language, pattern and length, and their progress."""
    __tablename__ = "enrollments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    owner: Mapped[str] = mapped_column(String(80), index=True)
    base: Mapped[str] = mapped_column(String(10))
    target: Mapped[str] = mapped_column(String(10))
    track: Mapped[str] = mapped_column(String(12))
    days: Mapped[int] = mapped_column(Integer)
    minutes: Mapped[int] = mapped_column(Integer)
    completed_days: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of day numbers
    minutes_log: Mapped[str] = mapped_column(Text, default="{}")  # JSON {"YYYY-MM-DD": minutes}
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
