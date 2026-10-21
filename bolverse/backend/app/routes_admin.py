"""Admin dashboard API (/admin/...). Separate email + password accounts with roles:

    owner    everything, including adding and removing dashboard users
    admin    users, subscriptions, payments, statistics, audit log
    finance  payments (approve or reject UPI), statistics, read-only users
    support  read-only users and payments

Every change is written to the audit log.
"""
from __future__ import annotations

import re

import hashlib
import hmac
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .config import settings
from .crypto import phone_key
from .db import SessionLocal, get_db
from .entitlements import PLAN_DAYS, PLAN_NAMES, active_subscription, problem, used_today
from .models import AdminSession, AdminUser, AuditLog, AuthSession, Connection, Payment, Subscription, User
from .routes_billing import activate, give_pass, reference, reject
from .security import hmac_hex, new_token, normalize_phone, utcnow

log = logging.getLogger("bolverse")
router = APIRouter(prefix="/admin", tags=["admin dashboard"])

ROLES = ("owner", "admin", "finance", "support")
PERMS: dict[str, set[str]] = {
    "owner": {"users.read", "users.write", "subs.write", "payments.read", "payments.verify", "stats.read",
              "audit.read", "admins.manage"},
    "admin": {"users.read", "users.write", "subs.write", "payments.read", "payments.verify", "stats.read", "audit.read"},
    "finance": {"users.read", "payments.read", "payments.verify", "stats.read"},
    "support": {"users.read", "payments.read"},
}
LOCK_AFTER = 5
LOCK_MINUTES = 15


# ---------- Passwords ----------

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240_000).hex()
    return f"pbkdf2_sha256$240000${salt}${digest}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
    except ValueError:
        return False
    test = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(rounds)).hex()
    return hmac.compare_digest(test, digest)


def password_ok(password: str) -> bool:
    return len(password) >= 10 and any(c.isdigit() for c in password) and any(c.isalpha() for c in password)


# ---------- Who is calling ----------

class AdminCtx:
    def __init__(self, admin: AdminUser, session: AdminSession):
        self.admin, self.session = admin, session

    def need(self, perm: str) -> None:
        if perm not in PERMS.get(self.admin.role, set()):
            raise problem(403, "forbidden", "Your dashboard role doesn't allow this.")


def current_admin(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> AdminCtx:
    token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else ""
    if not token:
        raise problem(401, "admin_login_required", "Sign in to the dashboard.")
    sess = db.scalar(select(AdminSession).where(AdminSession.token_hash == hmac_hex("admin:" + token)))
    if sess is None or sess.revoked_at is not None or sess.expires_at <= utcnow():
        raise problem(401, "admin_login_required", "Your dashboard session has ended. Sign in again.")
    admin = db.get(AdminUser, sess.admin_id)
    if admin is None or not admin.active:
        raise problem(401, "admin_login_required", "This dashboard account is disabled.")
    return AdminCtx(admin, sess)


def audit(db: Session, ctx: AdminCtx, action: str, target: str = "", **detail) -> None:
    db.add(AuditLog(admin_id=ctx.admin.id, admin_email=ctx.admin.email, action=action, target=target,
                    detail=json.dumps(detail, default=str) if detail else ""))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def _admin_out(a: AdminUser) -> dict:
    return {"id": a.id, "email": a.email, "name": a.name, "role": a.role, "active": a.active,
            "permissions": sorted(PERMS.get(a.role, set())), "last_login_at": _iso(a.last_login_at),
            "created_at": _iso(a.created_at)}


# ---------- Sign in ----------

class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=1, max_length=200)


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    admin = db.scalar(select(AdminUser).where(AdminUser.email == email))
    now = utcnow()
    if admin and admin.locked_until and admin.locked_until > now:
        raise problem(429, "admin_locked", "Too many wrong passwords. Try again in 15 minutes.")
    if admin is None or not admin.active or not check_password(body.password, admin.password_hash):
        if admin:
            admin.failed_logins = (admin.failed_logins or 0) + 1
            if admin.failed_logins >= LOCK_AFTER:
                admin.locked_until, admin.failed_logins = now + timedelta(minutes=LOCK_MINUTES), 0
            db.commit()
        raise problem(401, "admin_bad_login", "Wrong email or password.")
    admin.failed_logins, admin.locked_until, admin.last_login_at = 0, None, now
    token = new_token()
    db.add(AdminSession(admin_id=admin.id, token_hash=hmac_hex("admin:" + token),
                        expires_at=now + timedelta(hours=settings.admin_session_hours)))
    db.add(AuditLog(admin_id=admin.id, admin_email=admin.email, action="login",
                    detail=json.dumps({"ip": request.client.host if request.client else ""})))
    db.commit()
    return {"token": token, "admin": _admin_out(admin), "expires_in": settings.admin_session_hours * 3600}


@router.post("/logout")
def logout(ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    sess = db.get(AdminSession, ctx.session.id)
    sess.revoked_at = utcnow()
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(ctx: AdminCtx = Depends(current_admin)):
    return _admin_out(ctx.admin)


class OwnPasswordIn(BaseModel):
    current: str
    new: str = Field(min_length=10, max_length=200)


@router.post("/me/password")
def change_own_password(body: OwnPasswordIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    admin = db.get(AdminUser, ctx.admin.id)
    if not check_password(body.current, admin.password_hash):
        raise problem(400, "admin_bad_password", "Your current password isn't right.")
    if not password_ok(body.new):
        raise problem(422, "weak_password", "Use at least 10 characters with letters and numbers.")
    admin.password_hash = hash_password(body.new)
    audit(db, ctx, "password.change", admin.email)
    db.commit()
    return {"ok": True}


# ---------- Overview ----------

@router.get("/stats")
def stats(ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("stats.read")
    now = utcnow()
    day_ago, month_start = now - timedelta(days=1), now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    count = lambda q: db.scalar(q) or 0  # noqa: E731
    active = db.execute(select(Subscription.plan, func.count(func.distinct(Subscription.user_id)))
                        .where(Subscription.ends_at > now, Subscription.cancelled_at.is_(None))
                        .group_by(Subscription.plan)).all()
    revenue = db.execute(select(Payment.currency, func.sum(Payment.amount_minor), func.count())
                         .where(Payment.status == "paid", Payment.paid_at >= month_start,
                                Payment.provider != "admin").group_by(Payment.currency)).all()
    # last 14 days of sign-ups and paid passes
    days = []
    for i in range(13, -1, -1):
        start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        days.append({"date": start.date().isoformat(),
                     "signups": count(select(func.count()).select_from(User).where(User.created_at >= start, User.created_at < end)),
                     "paid": count(select(func.count()).select_from(Payment).where(
                         Payment.status == "paid", Payment.provider != "admin", Payment.paid_at >= start, Payment.paid_at < end))})
    return {
        "users": count(select(func.count()).select_from(User)),
        "new_users_24h": count(select(func.count()).select_from(User).where(User.created_at >= day_ago)),
        "active_users_24h": count(select(func.count()).select_from(User).where(User.last_login_at >= day_ago)),
        "blocked_users": count(select(func.count()).select_from(User).where(User.blocked.is_(True))),
        "premium_users": count(select(func.count(func.distinct(Subscription.user_id))).where(
            Subscription.ends_at > now, Subscription.cancelled_at.is_(None))),
        "active_by_plan": {plan: n for plan, n in active},
        "revenue_this_month": [{"currency": c, "amount": (a or 0) / 100, "payments": n} for c, a, n in revenue],
        "upi_to_verify": count(select(func.count()).select_from(Payment).where(Payment.status == "verifying")),
        "active_chats": count(select(func.count()).select_from(Connection).where(Connection.ended_at.is_(None))),
        "daily": days,
    }


# ---------- Users ----------

def _matching_user_ids(db: Session, term: str) -> list[str]:
    """Names and numbers are encrypted at rest, so search works on whole phone numbers (with or without
    +91) through the blind index, and on names by decrypting the most recent 5000 users."""
    term = term.strip()
    ids: set[str] = {term} if re.fullmatch(r"[0-9a-f]{32}", term) else set()
    digits = re.sub(r"[^\d+]", "", term)
    if len(digits.lstrip("+")) >= 6:
        for candidate in {digits, "+" + digits.lstrip("+"), "+91" + digits.lstrip("+")}:
            try:
                e164, _ = normalize_phone(candidate)
            except ValueError:
                continue
            uid = db.scalar(select(User.id).where(User.phone_key == phone_key(e164)))
            if uid:
                ids.add(uid)
    lower = term.lower()
    if not digits or len(term) > len(digits):
        for u in db.scalars(select(User).order_by(User.created_at.desc()).limit(5000)):
            if lower in u.name.lower():
                ids.add(u.id)
    return list(ids)


def _user_row(db: Session, u: User) -> dict:
    sub = active_subscription(db, u)
    return {"id": u.id, "name": u.name, "phone": u.phone, "country": u.country, "language": u.language,
            "gender": u.gender, "blocked": bool(u.blocked), "created_at": _iso(u.created_at),
            "last_login_at": _iso(u.last_login_at), "plan": "premium" if sub else "free",
            "premium_until": _iso(sub.ends_at) if sub else None, "premium_plan": sub.plan if sub else None,
            "translations_today": used_today(u), "translations_total": u.translations_used or 0}


@router.get("/users")
def users(q: str = "", plan: Literal["all", "premium", "free", "blocked"] = "all", page: int = Query(1, ge=1),
          ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("users.read")
    query = select(User)
    if q.strip():
        query = query.where(User.id.in_(_matching_user_ids(db, q)))
    now = utcnow()
    premium_ids = select(Subscription.user_id).where(Subscription.ends_at > now, Subscription.cancelled_at.is_(None))
    if plan == "premium":
        query = query.where(User.id.in_(premium_ids))
    elif plan == "free":
        query = query.where(User.id.not_in(premium_ids))
    elif plan == "blocked":
        query = query.where(User.blocked.is_(True))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(User.created_at.desc()).offset((page - 1) * 25).limit(25))
    return {"total": total, "page": page, "page_size": 25, "users": [_user_row(db, u) for u in rows]}


@router.get("/users/{uid}")
def user_detail(uid: str, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("users.read")
    u = db.get(User, uid)
    if u is None:
        raise problem(404, "not_found", "User not found.")
    subs = db.scalars(select(Subscription).where(Subscription.user_id == uid).order_by(Subscription.ends_at.desc()))
    pays = db.scalars(select(Payment).where(Payment.user_id == uid).order_by(Payment.created_at.desc()).limit(100))
    now = utcnow()
    return {
        **_user_row(db, u), "dob": u.dob.isoformat(),
        "subscriptions": [{"id": s.id, "plan": s.plan, "starts_at": _iso(s.starts_at), "ends_at": _iso(s.ends_at),
                           "cancelled_at": _iso(s.cancelled_at), "payment_id": s.payment_id,
                           "state": "cancelled" if s.cancelled_at else ("active" if s.starts_at <= now < s.ends_at
                                                                        else "upcoming" if s.starts_at > now else "ended")}
                          for s in subs],
        "payments": [_payment_row(p, u) for p in pays],
    }


class GrantIn(BaseModel):
    plan: Literal["day", "week", "month"]
    days: int | None = Field(default=None, ge=1, le=366)  # custom length; default is the plan's length
    note: str = Field(default="", max_length=300)


@router.post("/users/{uid}/grant")
def grant(uid: str, body: GrantIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("subs.write")
    u = db.get(User, uid)
    if u is None:
        raise problem(404, "not_found", "User not found.")
    days = body.days or PLAN_DAYS[body.plan]
    pay = Payment(user_id=uid, plan=body.plan, currency="INR" if u.country == "IN" else "USD", amount_minor=0,
                  provider="admin", method="grant", status="paid", paid_at=utcnow(), reviewed_by=ctx.admin.id,
                  note=body.note or f"Granted by {ctx.admin.email}")
    db.add(pay)
    db.flush()
    sub = give_pass(db, uid, body.plan, pay.id, days)
    audit(db, ctx, "subscription.grant", uid, plan=body.plan, days=days, note=body.note)
    db.commit()
    return {"ok": True, "ends_at": _iso(sub.ends_at)}


class CancelIn(BaseModel):
    subscription_id: str
    note: str = Field(default="", max_length=300)


@router.post("/users/{uid}/cancel-subscription")
def cancel_subscription(uid: str, body: CancelIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("subs.write")
    sub = db.get(Subscription, body.subscription_id)
    if sub is None or sub.user_id != uid:
        raise problem(404, "not_found", "Subscription not found.")
    if sub.cancelled_at is None:
        sub.cancelled_at = utcnow()
        audit(db, ctx, "subscription.cancel", uid, subscription=sub.id, plan=sub.plan, note=body.note)
        db.commit()
    return {"ok": True}


class BlockIn(BaseModel):
    blocked: bool
    note: str = Field(default="", max_length=300)


@router.post("/users/{uid}/block")
def block(uid: str, body: BlockIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("users.write")
    u = db.get(User, uid)
    if u is None:
        raise problem(404, "not_found", "User not found.")
    u.blocked = body.blocked
    if body.blocked:  # sign them out everywhere and end their chats
        db.execute(AuthSession.__table__.update().where(AuthSession.user_id == uid, AuthSession.revoked_at.is_(None))
                   .values(revoked_at=utcnow()))
        db.execute(Connection.__table__.update().where(Connection.ended_at.is_(None),
                                                       or_(Connection.user_a == uid, Connection.user_b == uid))
                   .values(ended_at=utcnow(), ended_by="admin"))
    audit(db, ctx, "user.block" if body.blocked else "user.unblock", uid, note=body.note)
    db.commit()
    return {"ok": True}


# ---------- Payments ----------

def _payment_row(p: Payment, u: User | None) -> dict:
    return {"id": p.id, "reference": reference(p.id), "user_id": p.user_id, "user_name": u.name if u else "",
            "user_phone": u.phone if u else "", "plan": p.plan, "plan_name": PLAN_NAMES.get(p.plan, p.plan),
            "currency": p.currency, "amount": p.amount_minor / 100, "provider": p.provider, "method": p.method,
            "utr": p.utr, "status": p.status, "note": p.note, "created_at": _iso(p.created_at), "paid_at": _iso(p.paid_at)}


@router.get("/payments")
def payments(status: str = "all", q: str = "", page: int = Query(1, ge=1),
             ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("payments.read")
    query = select(Payment, User).join(User, User.id == Payment.user_id, isouter=True)
    if status != "all":
        query = query.where(Payment.status == status)
    if q.strip():
        term = q.strip()
        query = query.where(or_(Payment.utr == term, Payment.id.ilike(term.removeprefix("BV").lower() + "%"),
                                Payment.user_id.in_(_matching_user_ids(db, term))))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.execute(query.order_by(Payment.created_at.desc()).offset((page - 1) * 25).limit(25)).all()
    return {"total": total, "page": page, "page_size": 25, "payments": [_payment_row(p, u) for p, u in rows]}


class ReviewIn(BaseModel):
    reason: str = Field(default="", max_length=300)


@router.post("/payments/{pid}/approve")
def approve_payment(pid: str, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("payments.verify")
    pay = db.get(Payment, pid)
    if pay is None:
        raise problem(404, "not_found", "Payment not found.")
    if pay.status not in ("verifying", "pending"):
        raise problem(409, "already_reviewed", f"This payment is already {pay.status}.")
    utr = pay.utr
    if not activate(db, pid, reviewed_by=ctx.admin.id):
        raise problem(409, "already_reviewed", "This payment was just reviewed by someone else.")
    audit(db, ctx, "payment.approve", pid, utr=utr, plan=pay.plan, amount=pay.amount_minor / 100)
    db.commit()
    return {"ok": True}


@router.post("/payments/{pid}/reject")
def reject_payment(pid: str, body: ReviewIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("payments.verify")
    pay = db.get(Payment, pid)
    if pay is None:
        raise problem(404, "not_found", "Payment not found.")
    utr = pay.utr
    if not reject(db, pid, body.reason or "Payment not received", ctx.admin.id):
        raise problem(409, "already_reviewed", f"This payment is already {pay.status}.")
    audit(db, ctx, "payment.reject", pid, utr=utr, reason=body.reason)
    db.commit()
    return {"ok": True}


# ---------- Dashboard users (owner only) ----------

class AdminIn(BaseModel):
    email: str = Field(min_length=3, max_length=120, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(min_length=1, max_length=80)
    role: Literal["owner", "admin", "finance", "support"]
    password: str = Field(min_length=10, max_length=200)


class AdminPatch(BaseModel):
    role: Literal["owner", "admin", "finance", "support"] | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=10, max_length=200)
    name: str | None = Field(default=None, min_length=1, max_length=80)


@router.get("/admins")
def list_admins(ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("admins.manage")
    return [_admin_out(a) for a in db.scalars(select(AdminUser).order_by(AdminUser.created_at))]


@router.post("/admins")
def create_admin(body: AdminIn, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("admins.manage")
    email = body.email.strip().lower()
    if db.scalar(select(AdminUser.id).where(AdminUser.email == email)):
        raise problem(409, "admin_exists", "A dashboard user with this email already exists.")
    if not password_ok(body.password):
        raise problem(422, "weak_password", "Use at least 10 characters with letters and numbers.")
    a = AdminUser(email=email, name=body.name.strip(), role=body.role, password_hash=hash_password(body.password))
    db.add(a)
    db.flush()
    audit(db, ctx, "admin.create", email, role=body.role)
    db.commit()
    return _admin_out(a)


@router.patch("/admins/{aid}")
def update_admin(aid: str, body: AdminPatch, ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("admins.manage")
    a = db.get(AdminUser, aid)
    if a is None:
        raise problem(404, "not_found", "Dashboard user not found.")
    owners = db.scalar(select(func.count()).select_from(AdminUser).where(AdminUser.role == "owner", AdminUser.active.is_(True)))
    losing_owner = a.role == "owner" and a.active and ((body.role and body.role != "owner") or body.active is False)
    if losing_owner and owners <= 1:
        raise problem(409, "last_owner", "There must always be at least one active owner.")
    changes = {}
    if body.role is not None and body.role != a.role:
        changes["role"] = [a.role, body.role]
        a.role = body.role
    if body.active is not None and body.active != a.active:
        changes["active"] = body.active
        a.active = body.active
        if not body.active:
            db.execute(AdminSession.__table__.update().where(AdminSession.admin_id == aid).values(revoked_at=utcnow()))
    if body.name:
        a.name = body.name.strip()
    if body.password:
        if not password_ok(body.password):
            raise problem(422, "weak_password", "Use at least 10 characters with letters and numbers.")
        a.password_hash, a.locked_until, a.failed_logins = hash_password(body.password), None, 0
        changes["password"] = "reset"
    audit(db, ctx, "admin.update", a.email, **changes)
    db.commit()
    return _admin_out(a)


# ---------- Audit log ----------

@router.get("/audit")
def audit_log(page: int = Query(1, ge=1), ctx: AdminCtx = Depends(current_admin), db: Session = Depends(get_db)):
    ctx.need("audit.read")
    total = db.scalar(select(func.count()).select_from(AuditLog))
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).offset((page - 1) * 50).limit(50))
    return {"total": total, "page": page, "page_size": 50,
            "entries": [{"id": r.id, "admin": r.admin_email, "action": r.action, "target": r.target,
                         "detail": json.loads(r.detail) if r.detail else {}, "at": _iso(r.created_at)} for r in rows]}


# ---------- First owner ----------

def ensure_first_owner() -> None:
    """Creates the owner from BOLVERSE_ADMIN_EMAIL / BOLVERSE_ADMIN_PASSWORD when no admin exists yet."""
    if not settings.admin_email or not settings.admin_password:
        return
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(AdminUser)):
            return
        if not password_ok(settings.admin_password):
            log.error("BOLVERSE_ADMIN_PASSWORD is too weak (10+ characters with letters and numbers): owner not created.")
            return
        db.add(AdminUser(email=settings.admin_email.strip().lower(), name="Owner", role="owner",
                         password_hash=hash_password(settings.admin_password)))
        db.commit()
        log.info("Created dashboard owner %s", settings.admin_email)
