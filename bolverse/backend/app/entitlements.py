"""Who is calling, what they may use, and the account view.

Guests (no login) can translate straight away: everyone gets BOLVERSE_FREE_TRANSLATIONS in total (counted
per device and per account), then the paywall; buying a pass needs a login. Connect, payments and the
profile need a signed-in user. Premium removes the limit. Setting BOLVERSE_FREE_TRANSLATIONS_PER_DAY gives
signed-in free users a daily allowance instead.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy import case, select, update
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, Device, Subscription, User
from .security import hmac_hex, mask_phone, utcnow

PLAN_DAYS = {"day": 1, "week": 7, "month": 30}
PLAN_NAMES = {"day": "1 day", "week": "1 week", "month": "1 month"}
_DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def problem(status: int, code: str, message: str, **extra) -> HTTPException:
    """Errors clients can act on: detail = {code, message, ...}."""
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


@dataclass
class Actor:
    device: Device
    user: User | None
    session: AuthSession | None
    subscription: Subscription | None
    region: str

    @property
    def premium(self) -> bool:
        return self.subscription is not None

    @property
    def voice_gender(self) -> str | None:
        return self.user.voice_gender if self.user else None


def active_subscription(db: Session, user: User | None) -> Subscription | None:
    if user is None:
        return None
    return db.scalar(
        select(Subscription).where(Subscription.user_id == user.id, Subscription.ends_at > utcnow(),
                                   Subscription.cancelled_at.is_(None))
        .order_by(Subscription.ends_at.desc()).limit(1)
    )


def get_actor(
    db: Session = Depends(get_db),
    x_device_id: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
    x_region: str | None = Header(default=None),
    device: str | None = Query(default=None, include_in_schema=False),
    session: str | None = Query(default=None, include_in_schema=False),
) -> Actor:
    """Device and session come from headers, or from ?device=&session= for audio players that can't send headers."""
    device_id = x_device_id or device
    if not device_id or not _DEVICE_ID.match(device_id):
        raise problem(400, "device_required", "This app version is missing a device ID. Update the app.")
    if not settings.accounts_enabled:
        return Actor(device=Device(id=device_id), user=None, session=None, subscription=None,
                     region=(x_region or "").upper()[:2])
    now = utcnow()
    dev = db.get(Device, device_id)
    if dev is None:
        dev = Device(id=device_id)
        db.add(dev)
    dev.last_seen_at = now

    token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else session
    user = sess = None
    if token:
        sess = _session_for(db, token, device_id, now)
        user = db.get(User, sess.user_id)
        if user is None:
            raise problem(401, "session_expired", "You've been signed out. Log in again.")
        if user.blocked:
            db.commit()
            raise problem(403, "account_blocked", "This account has been suspended. Contact Bolverse support.")
        sess.last_used_at = now
        dev.user_id = user.id
    db.commit()
    region = (user.country if user else (x_region or "")).upper()[:2]
    return Actor(device=dev, user=user, session=sess, subscription=active_subscription(db, user), region=region)


def _session_for(db: Session, token: str, device_id: str, now: datetime) -> AuthSession:
    from .tokens import TokenExpired, TokenInvalid, looks_like_jwt, read_access

    signed_out = problem(401, "session_expired", "You've been signed out. Log in again.")
    if looks_like_jwt(token):
        try:
            claims = read_access(token)
        except TokenExpired:
            raise problem(401, "token_expired", "Session needs refreshing.")
        except TokenInvalid:
            raise signed_out
        sess = db.get(AuthSession, claims["sid"])
        if (sess is None or sess.kind != "refresh" or sess.user_id != claims["sub"] or claims["did"] != device_id
                or sess.revoked_at is not None or sess.expires_at <= now):
            db.commit()
            raise signed_out
        return sess
    # A long-lived token from an app version before 1.2.
    if not settings.allow_legacy_sessions:
        raise problem(401, "session_expired", "Please update Bolverse and log in again.")
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == hmac_hex("session:" + token),
                                               AuthSession.kind == "legacy"))
    if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
        db.commit()
        raise signed_out
    return sess


def require_login(actor: Actor) -> None:
    if settings.accounts_enabled and actor.user is None:
        raise problem(401, "login_required", "Please log in with your mobile number to use Bolverse.")


def require_user(actor: Actor) -> User:
    if actor.user is None:
        raise problem(401, "login_required", "Please log in with your mobile number to use Bolverse.")
    return actor.user


# ---------- Daily limit ----------

def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.timezone)
    except Exception:
        return ZoneInfo("UTC")


def today() -> date:
    return datetime.now(_tz()).date()


def resets_at() -> str:
    """Next local midnight, as UTC ISO time."""
    tz = _tz()
    midnight = datetime.combine(today() + timedelta(days=1), time.min, tzinfo=tz)
    return midnight.astimezone(timezone.utc).replace(tzinfo=None).isoformat() + "Z"


def used_today(user: User | None) -> int:
    if user is None or user.translations_day != today():
        return 0
    return user.translations_today or 0


def daily_mode(actor: Actor) -> bool:
    """Signed-in free users get a daily allowance only when BOLVERSE_FREE_TRANSLATIONS_PER_DAY is set."""
    return settings.free_translations_per_day > 0 and actor.user is not None


def used_total(actor: Actor) -> int:
    if actor.user is not None:
        return max(actor.user.translations_used or 0, actor.device.translations_used or 0)
    return actor.device.translations_used or 0


def translations_left(actor: Actor) -> int | None:
    if not settings.accounts_enabled or actor.premium:
        return None
    if daily_mode(actor):
        return max(0, settings.free_translations_per_day - used_today(actor.user))
    return max(0, settings.free_translations - used_total(actor))


def check_translation_quota(actor: Actor) -> None:
    """Guests and free users: BOLVERSE_FREE_TRANSLATIONS in total (or a daily allowance), then the paywall.
    A guest must log in to buy a pass, which the app does as part of the paywall."""
    if not settings.accounts_enabled or actor.premium:
        return
    if translations_left(actor) == 0:
        if daily_mode(actor):
            raise problem(402, "quota_exceeded",
                          f"You've used today's {settings.free_translations_per_day} free translations. "
                          "Get Premium for unlimited translations, or come back after midnight.",
                          limit=settings.free_translations_per_day, resets_at=resets_at(), signup=False)
        raise problem(402, "quota_exceeded",
                      f"You've used your {settings.free_translations} free translations. "
                      "Get Premium to keep going.", limit=settings.free_translations, resets_at=None,
                      signup=actor.user is None)


def record_translation(db: Session, actor: Actor) -> None:
    if not settings.accounts_enabled:
        return
    # The device count also follows guests who later sign in, so a new account doesn't reset the free uses.
    db.execute(update(Device).where(Device.id == actor.device.id).values(
        translations_used=Device.translations_used + 1))
    if actor.user is not None:
        day = today()
        db.execute(update(User).where(User.id == actor.user.id).values(
            translations_today=case((User.translations_day == day, User.translations_today + 1), else_=1),
            translations_day=day,
            translations_used=User.translations_used + 1,
        ))
    db.commit()
    db.refresh(actor.device)
    if actor.user is not None:
        db.refresh(actor.user)


# ---------- Learning (switched off for now; kept for later) ----------

def owner_key(actor: Actor) -> str:
    return f"user:{actor.user.id}" if actor.user else f"device:{actor.device.id}"


def check_course_day(actor: Actor, day: int) -> None:
    if not settings.accounts_enabled or actor.premium or day <= settings.free_course_days:
        return
    raise problem(402, "premium_required", "Get Premium to continue your course.", feature="course")


# ---------- Prices and the account view ----------

def currency_for(region: str) -> str:
    return "INR" if region == "IN" else "USD"


def price_minor(plan: str, currency: str) -> int:
    """Price in paise / cents."""
    return getattr(settings, f"price_{currency.lower()}_{plan}")


def price_label(amount_minor: int, currency: str) -> str:
    major = amount_minor / 100
    text = f"{major:.0f}" if amount_minor % 100 == 0 else f"{major:.2f}"
    return f"₹{text}" if currency == "INR" else f"${text}"


def payment_methods(currency: str) -> list[str]:
    methods = []
    if currency == "INR" and settings.upi_id:
        methods.append("upi")
    provider = settings.payment_provider_inr if currency == "INR" else settings.payment_provider_usd
    if provider in ("cashfree", "razorpay") or (provider == "dev" and settings.dev_mode):
        methods.append("card")
    return methods


def prices(region: str) -> list[dict]:
    cur = currency_for(region)
    return [
        {"plan": plan, "days": days, "name": PLAN_NAMES[plan], "currency": cur, "amount_minor": price_minor(plan, cur),
         "amount": price_minor(plan, cur) / 100, "label": price_label(price_minor(plan, cur), cur)}
        for plan, days in PLAN_DAYS.items() if price_minor(plan, cur) > 0
    ]


def _usage(actor: Actor) -> dict:
    """`today` and `daily_limit` keep their names for older apps; with the total allowance they mean
    "used so far" and "free in total", and `kind` says which."""
    if actor.premium:
        return {"kind": "unlimited", "today": 0, "daily_limit": None, "resets_at": None, "left": None}
    if daily_mode(actor):
        return {"kind": "daily", "today": used_today(actor.user), "daily_limit": settings.free_translations_per_day,
                "resets_at": resets_at(), "left": translations_left(actor)}
    return {"kind": "total", "today": used_total(actor), "daily_limit": settings.free_translations,
            "resets_at": None, "left": translations_left(actor)}


def account_view(actor: Actor) -> dict:
    if not settings.accounts_enabled:
        return {"user": None, "plan": "open", "subscription": None,
                "usage": {"today": 0, "daily_limit": None, "resets_at": resets_at()},
                "prices": [], "features": {"learning": settings.learning_enabled}}
    user, sub = actor.user, actor.subscription
    return {
        "user": None if user is None else {
            "id": user.id, "name": user.name, "phone": mask_phone(user.phone), "dob": user.dob.isoformat(),
            "gender": user.gender or "", "voice_gender": user.voice_gender or "female",
            "language": user.language or "en-US", "country": user.country,
            "member_since": user.created_at.date().isoformat(),
        },
        "plan": "premium" if sub else ("free" if user else "guest"),
        "subscription": None if sub is None else {
            "plan": sub.plan,
            "valid_until": sub.ends_at.isoformat() + "Z",
            "days_left": max(0, (sub.ends_at - utcnow() + timedelta(hours=23, minutes=59)).days),
        },
        "usage": _usage(actor),
        "prices": prices(actor.region),
        "payment_methods": payment_methods(currency_for(actor.region)),
        "features": {"learning": settings.learning_enabled},
    }
