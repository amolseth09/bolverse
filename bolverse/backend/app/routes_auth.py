"""Sign in with a mobile number and an SMS code. First-time users then add name, date of birth,
gender and language. There are no passwords.

    POST /auth/otp       {phone}                    -> code sent; says whether the number is registered
    POST /auth/verify    {phone, code}              -> signed in, or a signup_token for new users
    POST /auth/complete  {signup_token, name, dob, gender, voice_gender?, language} -> signed in
    POST /auth/refresh   {refresh_token}            -> new access + refresh token (the old refresh token dies)
    POST /auth/logout    {refresh_token?}           -> session revoked on the server

Signed in = {access_token (15 min), refresh_token (rotating, 90 days), expires_in}; `token` repeats the
access token for older apps.

Codes: 6 digits, valid 5 minutes, 5 wrong tries per code, 30 s between requests for a number, daily
limits per number and per network (IP), short-window limits per IP, stored only as a keyed hash. Phone
numbers are stored as a blind index (see crypto.py). Auth events are logged with masked numbers and never
with codes.
"""
from __future__ import annotations

import logging
import unicodedata
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from . import ratelimit
from .config import settings
from .crypto import phone_key
from .db import get_db
from .entitlements import Actor, account_view, active_subscription, get_actor, problem, require_user
from .languages import find
from .models import AuthSession, Enrollment, OtpCode, User, VocabTerm
from .security import hmac_hex, make_signup_token, mask_phone, new_otp, normalize_phone, read_signup_token, same, utcnow
from .seed import TEST_CODE, TEST_PHONES
from .sms import SmsError, deliver, get_provider
from .tokens import REFRESH_RACE_SECONDS, make_access, new_refresh, refresh_hash

router = APIRouter(tags=["account"])
log = logging.getLogger("bolverse.auth")
MAX_ATTEMPTS = 5
PURPOSE = "auth"


def _name_ok(value: str) -> str:
    name = " ".join(value.split())
    if not name or len(name) > 80:
        raise ValueError("Enter your name (up to 80 letters).")
    for ch in name:
        if not (unicodedata.category(ch)[0] in "LM" or ch in " .'-"):
            raise ValueError("Use letters only in your name.")
    return name


class PhoneIn(BaseModel):
    phone: str = Field(min_length=6, max_length=24, pattern=r"^[+\d\s()-]+$")


class VerifyIn(PhoneIn):
    code: str = Field(pattern=r"^\d{6}$")


class CompleteIn(BaseModel):
    signup_token: str = Field(max_length=300)
    name: str = Field(min_length=1, max_length=80)
    dob: date
    gender: Literal["male", "female", "other"]
    voice_gender: Literal["male", "female"] | None = None  # needed when gender is "other"
    language: str = Field(default="en-US", max_length=10)

    @field_validator("name")
    @classmethod
    def _clean(cls, v: str) -> str:
        return _name_ok(v)


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    voice_gender: Literal["male", "female"] | None = None
    language: str | None = Field(default=None, max_length=10)

    @field_validator("name")
    @classmethod
    def _clean(cls, v: str | None) -> str | None:
        return None if v is None else _name_ok(v)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=200)


class LogoutIn(BaseModel):
    refresh_token: str | None = Field(default=None, max_length=200)


def _ip(request: Request) -> str:
    # Behind Caddy/Nginx the client address is in X-Forwarded-For (first entry).
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:64]


def accounts_on() -> None:
    if not settings.accounts_enabled:
        raise problem(404, "accounts_disabled", "Accounts are switched off on this server.")


def _phone(raw: str) -> tuple[str, str]:
    try:
        return normalize_phone(raw)
    except ValueError:
        raise problem(422, "invalid_phone", "Enter a valid mobile number, including the country code.")


def _age(dob: date, today: date) -> int:
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


on = [Depends(accounts_on)]


@router.post("/auth/otp", dependencies=on)
def request_otp(body: PhoneIn, request: Request, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    phone, _ = _phone(body.phone)
    key = phone_key(phone)
    ip = _ip(request)
    test_user = settings.dev_mode and phone in TEST_PHONES
    if not test_user:
        if not ratelimit.allow(f"otp-ip:{ip}", settings.otp_ip_per_minute, 60) or not ratelimit.allow(f"otp-num:{key}", 3, 600):
            log.warning("auth.otp_rate_limited phone=%s ip=%s", mask_phone(phone), ip)
            raise problem(429, "rate_limited", "Too many requests. Wait a minute and try again.", retry_in=60)
    registered = db.scalar(select(User.id).where(User.phone_key == key)) is not None
    now = utcnow()
    if not test_user:
        last = db.scalar(select(OtpCode).where(OtpCode.phone == key).order_by(OtpCode.created_at.desc()).limit(1))
        if last and (now - last.created_at).total_seconds() < settings.otp_resend_seconds:
            wait = settings.otp_resend_seconds - int((now - last.created_at).total_seconds())
            raise problem(429, "otp_cooldown", f"Wait {wait} seconds before asking for a new code.", retry_in=wait)
        day = now - timedelta(days=1)
        count = select(func.count()).select_from(OtpCode)
        if db.scalar(count.where(OtpCode.phone == key, OtpCode.created_at > day)) >= settings.otp_daily_limit:
            log.warning("auth.otp_daily_limit phone=%s", mask_phone(phone))
            raise problem(429, "otp_daily_limit", "Too many codes for this number today. Try again tomorrow.")
        if ip and db.scalar(count.where(OtpCode.ip == ip, OtpCode.created_at > day)) >= settings.otp_ip_daily:
            log.warning("auth.otp_ip_daily_limit ip=%s", ip)
            raise problem(429, "otp_daily_limit", "Too many codes requested from this network today. Try again tomorrow.")

    provider = get_provider()
    own_code = not test_user and provider.issues_own_code
    code = TEST_CODE if test_user else (None if own_code else new_otp())
    # Older codes for this number stop working as soon as a new one is issued.
    db.execute(update(OtpCode).where(OtpCode.phone == key, OtpCode.consumed_at.is_(None)).values(consumed_at=now))
    db.add(OtpCode(phone=key, purpose=PURPOSE, code_hash=hmac_hex(f"otp:{phone}:{code}") if code else "provider:" + provider.name,
                   ip=ip, expires_at=now + timedelta(seconds=settings.otp_ttl_seconds)))
    db.commit()
    if not test_user:
        try:
            deliver(phone, code)
        except SmsError:
            raise problem(502, "sms_failed", "We couldn't send the SMS. Check the number and try again.")
    log.info("auth.otp_sent phone=%s ip=%s registered=%s provider=%s", mask_phone(phone), ip, registered,
             "test" if test_user else provider.name)
    out = {"sent": True, "registered": registered, "expires_in": settings.otp_ttl_seconds,
           "resend_in": settings.otp_resend_seconds}
    if settings.dev_mode and (test_user or provider.name == "console"):
        out["dev_code"] = code  # development only: lets you sign in without an SMS provider
    return out


def _consume(db: Session, phone: str, code: str, ip: str) -> None:
    if not ratelimit.allow(f"verify-ip:{ip}", settings.verify_ip_per_10min, 600):
        log.warning("auth.verify_rate_limited ip=%s", ip)
        raise problem(429, "rate_limited", "Too many tries from this network. Wait a few minutes.", retry_in=600)
    otp = db.scalar(select(OtpCode).where(OtpCode.phone == phone_key(phone), OtpCode.consumed_at.is_(None))
                    .order_by(OtpCode.created_at.desc()).limit(1))
    if otp is None or otp.expires_at <= utcnow():
        raise problem(400, "otp_expired", "This code has expired. Ask for a new one.")
    if otp.attempts >= MAX_ATTEMPTS:
        raise problem(429, "otp_locked", "Too many wrong tries. Ask for a new code.")
    if otp.code_hash.startswith("provider:"):
        try:
            ok = get_provider().check(phone, code)
        except Exception:
            log.error("auth.verify_provider_error phone=%s", mask_phone(phone))
            raise problem(502, "sms_failed", "We couldn't check the code right now. Try again.")
    else:
        ok = same(otp.code_hash, hmac_hex(f"otp:{phone}:{code}"))
    if not ok:
        otp.attempts += 1
        db.commit()
        left = MAX_ATTEMPTS - otp.attempts
        log.info("auth.otp_wrong phone=%s ip=%s left=%d", mask_phone(phone), ip, left)
        if left <= 0:
            raise problem(429, "otp_locked", "Too many wrong tries. Ask for a new code.")
        raise problem(400, "otp_invalid", f"That code isn't right. {left} {'try' if left == 1 else 'tries'} left.")
    otp.consumed_at = utcnow()


def _tokens_for(session: AuthSession, refresh: str) -> dict:
    access, expires_in = make_access(session.id, session.user_id, session.device_id)
    return {"access_token": access, "refresh_token": refresh, "expires_in": expires_in, "token": access}


def _sign_in(db: Session, user: User, actor: Actor) -> dict:
    if user.blocked:
        db.commit()
        log.warning("auth.blocked_login user=%s", user.id[:8])
        raise problem(403, "account_blocked", "This account has been suspended. Contact Bolverse support.")
    refresh, refresh_h = new_refresh()
    session = AuthSession(user_id=user.id, kind="refresh", token_hash=refresh_h, device_id=actor.device.id,
                          expires_at=utcnow() + timedelta(days=settings.session_days))
    db.add(session)
    actor.device.user_id = user.id
    user.last_login_at = utcnow()
    # Free uses made as a guest on this device count for the account too.
    user.translations_used = max(user.translations_used or 0, actor.device.translations_used or 0)
    guest, owner = f"device:{actor.device.id}", f"user:{user.id}"
    for table in (Enrollment, VocabTerm):
        db.execute(update(table).where(table.owner == guest).values(owner=owner))
    db.commit()
    actor.user, actor.region = user, user.country
    actor.subscription = active_subscription(db, user)
    log.info("auth.signed_in user=%s device=%s session=%s", user.id[:8], actor.device.id[:8], session.id[:8])
    return {"status": "signed_in", **_tokens_for(session, refresh), "account": account_view(actor)}


@router.post("/auth/verify", dependencies=on)
def verify(body: VerifyIn, request: Request, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    phone, _ = _phone(body.phone)
    _consume(db, phone, body.code, _ip(request))
    user = db.scalar(select(User).where(User.phone_key == phone_key(phone)))
    if user is not None:
        return _sign_in(db, user, actor)
    db.commit()
    log.info("auth.verified_new phone=%s", mask_phone(phone))
    return {"status": "new_user", "signup_token": make_signup_token(phone)}


@router.post("/auth/complete", dependencies=on)
def complete(body: CompleteIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    phone = read_signup_token(body.signup_token)
    if phone is None:
        raise problem(400, "signup_expired", "That took a while. Verify your number again to finish signing up.")
    name = body.name
    today = utcnow().date()
    if body.dob >= today or body.dob.year < 1900:
        raise problem(422, "invalid_dob", "Enter a real date of birth.")
    if _age(body.dob, today) < settings.min_age:
        raise problem(422, "too_young", f"You need to be at least {settings.min_age} to use Bolverse.")
    if find(body.language) is None:
        raise problem(422, "invalid_language", "Choose your language from the list.")
    voice = body.voice_gender or (body.gender if body.gender in ("male", "female") else None)
    if voice is None:
        raise problem(422, "voice_required", "Choose which voice Bolverse should use when it speaks for you.")
    existing = db.scalar(select(User).where(User.phone_key == phone_key(phone)))
    if existing is not None:
        return _sign_in(db, existing, actor)
    _, region = normalize_phone(phone)
    user = User(phone=phone, name=name, dob=body.dob, gender=body.gender, voice_gender=voice,
                language=find(body.language).code, country=region)
    db.add(user)
    db.flush()
    return _sign_in(db, user, actor)


@router.post("/auth/refresh", dependencies=on)
def refresh(body: RefreshIn, request: Request, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """Swaps a refresh token for a new access token and a new refresh token."""
    if not ratelimit.allow(f"refresh:{actor.device.id}", 30, 60):
        raise problem(429, "rate_limited", "Too many requests. Wait a minute and try again.", retry_in=60)
    now = utcnow()
    presented = refresh_hash(body.refresh_token)
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == presented, AuthSession.kind == "refresh"))
    if sess is None:
        old = db.scalar(select(AuthSession).where(AuthSession.prev_token_hash == presented, AuthSession.kind == "refresh"))
        if old is not None and old.revoked_at is None:
            if old.rotated_at and (now - old.rotated_at).total_seconds() < REFRESH_RACE_SECONDS and old.device_id == actor.device.id:
                raise problem(409, "refresh_race", "Already refreshed; use the newest token.")
            # An already-used refresh token came back: someone has a copy. End the session everywhere.
            old.revoked_at, old.revoked_reason = now, "reuse"
            db.commit()
            log.warning("auth.refresh_reuse session=%s user=%s ip=%s", old.id[:8], old.user_id[:8], _ip(request))
        raise problem(401, "session_expired", "You've been signed out. Log in again.")
    if sess.revoked_at is not None or sess.expires_at <= now or sess.device_id != actor.device.id:
        log.info("auth.refresh_refused session=%s reason=%s", sess.id[:8],
                 "revoked" if sess.revoked_at else "expired" if sess.expires_at <= now else "device")
        raise problem(401, "session_expired", "You've been signed out. Log in again.")
    user = db.get(User, sess.user_id)
    if user is None or user.blocked:
        raise problem(401, "session_expired", "You've been signed out. Log in again.")
    token, token_h = new_refresh()
    sess.prev_token_hash, sess.token_hash, sess.rotated_at, sess.last_used_at = sess.token_hash, token_h, now, now
    db.commit()
    return _tokens_for(sess, token)


@router.post("/auth/logout", dependencies=on)
def logout(body: LogoutIn | None = None, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    now = utcnow()
    sessions = [actor.session] if actor.session else []
    if body and body.refresh_token:
        h = refresh_hash(body.refresh_token)
        sessions += db.scalars(select(AuthSession).where(or_(AuthSession.token_hash == h, AuthSession.prev_token_hash == h),
                                                         AuthSession.device_id == actor.device.id)).all()
    for sess in sessions:
        if sess.revoked_at is None:
            sess.revoked_at, sess.revoked_reason = now, "logout"
            log.info("auth.logout session=%s user=%s", sess.id[:8], sess.user_id[:8])
    actor.device.user_id = None
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(actor: Actor = Depends(get_actor)):
    return account_view(actor)


@router.patch("/me", dependencies=on)
def update_me(body: ProfileIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    if body.name is not None:
        user.name = body.name
    if body.voice_gender is not None:
        user.voice_gender = body.voice_gender
    if body.language is not None:
        if find(body.language) is None:
            raise problem(422, "invalid_language", "Choose your language from the list.")
        user.language = find(body.language).code
    db.commit()
    return account_view(actor)
