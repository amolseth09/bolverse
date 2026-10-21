"""Dummy data for development and testing. Created only while BOLVERSE_DEV_MODE=true; safe to run again.

    python -m app.seed

App users (all log in with the code 123456):
    +91 90000 00001  Asha Verma     female  Hindi      free, 30 of 50 free translations used
    +91 90000 00002  Rahul Mehta    male    Hindi      Premium (week), 2 days left
    +91 90000 00003  Priya Nair     female  Malayalam  Premium (month), 18 days left
    +91 90000 00004  Vikram Singh   male    Punjabi    Premium expired, free translations used up
    +91 90000 00005  Arjun Rao      male    Tamil      free; has a UPI payment waiting for verification
    +91 90000 00006  Meera Iyer     female  Bengali    Premium (day pass)
    +91 90000 00007  Sanjay Gupta   male    Hindi      blocked by an admin
    +1 202 555 0143  Emma Johnson   female  English    international (US$ prices)
    +34 612 345 678  Lucía García   female  Spanish    international, Premium (month)
    +971 50 123 4567 Omar Haddad    male    Arabic     international, free

Already connected for chat tests: Asha <-> Rahul (Hindi <-> Hindi) and Emma <-> Lucía (English <-> Spanish),
each with one message waiting.

Dashboard (http://localhost:8000/dashboard):
    owner@bolverse.test    Owner@12345    owner
    admin@bolverse.test    Admin@12345    admin
    finance@bolverse.test  Finance@12345  finance
    support@bolverse.test  Support@12345  support
"""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .crypto import phone_key
from .db import SessionLocal, init_db
from .models import AdminUser, Connection, ConnectMessage, Payment, Subscription, User
from .security import normalize_phone, utcnow

TEST_CODE = "123456"
# phone, name, date of birth, gender, language, used today, plan, days left (negative = expired), blocked
TEST_USERS = [
    ("+919000000001", "Asha Verma", date(1996, 3, 14), "female", "hi-IN", 30, None, None, False),
    ("+919000000002", "Rahul Mehta", date(1990, 7, 22), "male", "hi-IN", 0, "week", 2, False),
    ("+919000000003", "Priya Nair", date(1993, 11, 5), "female", "ml-IN", 0, "month", 18, False),
    ("+919000000004", "Vikram Singh", date(1988, 1, 30), "male", "pa-IN", 50, "month", -3, False),
    ("+919000000005", "Arjun Rao", date(1998, 5, 2), "male", "ta-IN", 4, None, None, False),
    ("+919000000006", "Meera Iyer", date(1995, 8, 19), "female", "bn-IN", 0, "day", 1, False),
    ("+919000000007", "Sanjay Gupta", date(1985, 12, 1), "male", "hi-IN", 0, None, None, True),
    ("+12025550143", "Emma Johnson", date(1992, 9, 9), "female", "en-US", 5, None, None, False),
    ("+34612345678", "Lucía García", date(1994, 4, 23), "female", "es-ES", 0, "month", 25, False),
    ("+971501234567", "Omar Haddad", date(1991, 2, 11), "male", "ar-SA", 0, None, None, False),
]
TEST_PHONES = {p for p, *_ in TEST_USERS}
TEST_ADMINS = [
    ("owner@bolverse.test", "Olivia Owner", "owner", "Owner@12345"),
    ("admin@bolverse.test", "Aman Admin", "admin", "Admin@12345"),
    ("finance@bolverse.test", "Farah Finance", "finance", "Finance@12345"),
    ("support@bolverse.test", "Sam Support", "support", "Support@12345"),
]
PRICES = {("day", "INR"): 2000, ("week", "INR"): 10000, ("month", "INR"): 25000,
          ("day", "USD"): 99, ("week", "USD"): 399, ("month", "USD"): 999}
DAYS = {"day": 1, "week": 7, "month": 30}


def _today() -> date:
    from .config import settings

    try:
        return datetime.now(ZoneInfo(settings.timezone)).date()
    except Exception:
        return date.today()


def seed() -> list[str]:
    from .routes_admin import hash_password

    init_db()
    created: list[str] = []
    with SessionLocal() as db:
        now = utcnow()
        users: dict[str, User] = {}
        for phone, name, dob, gender, language, used, plan, days_left, blocked in TEST_USERS:
            e164, region = normalize_phone(phone)
            user = db.scalar(select(User).where(User.phone_key == phone_key(e164)))
            if user is not None:
                users[e164] = user
                continue
            user = User(phone=e164, name=name, dob=dob, gender=gender, voice_gender=gender, language=language,
                        country=region, translations_today=used, translations_day=_today(), translations_used=used,
                        blocked=blocked, created_at=now - timedelta(days=len(users) + 2), last_login_at=now - timedelta(hours=3))
            db.add(user)
            db.flush()
            users[e164] = user
            currency = "INR" if region == "IN" else "USD"
            if plan:
                ends = now + timedelta(days=days_left)
                start = ends - timedelta(days=DAYS[plan])
                pay = Payment(user_id=user.id, plan=plan, currency=currency, amount_minor=PRICES[(plan, currency)],
                              provider="upi" if currency == "INR" else "cashfree",
                              method="upi" if currency == "INR" else "card", status="paid", paid_at=start, created_at=start,
                              utr=f"6{int(hashlib.sha256(e164.encode()).hexdigest(), 16) % 10**11:011d}" if currency == "INR" else None)
                db.add(pay)
                db.flush()
                db.add(Subscription(user_id=user.id, plan=plan, starts_at=start, ends_at=ends, payment_id=pay.id))
            created.append(f"{name} ({phone})")

        arjun = users.get("+919000000005")
        def has_utr(utr: str) -> bool:
            return bool(db.scalar(select(Payment.id).where(Payment.utr == utr)))

        if arjun and not has_utr("612345678901"):
            db.add(Payment(user_id=arjun.id, plan="week", currency="INR", amount_minor=10000, provider="upi", method="upi",
                           status="verifying", utr="612345678901", created_at=now - timedelta(minutes=40)))
        if arjun and not has_utr("698765432109"):
            db.add(Payment(user_id=arjun.id, plan="day", currency="INR", amount_minor=2000, provider="upi", method="upi",
                           status="rejected", utr="698765432109", note="No matching credit in the bank account",
                           created_at=now - timedelta(days=2)))

        def link(a: str, b: str, text: str, translation: str) -> None:
            ua, ub = users.get(a), users.get(b)
            if not ua or not ub or db.scalar(select(Connection.id).where(Connection.user_a == ua.id, Connection.user_b == ub.id)):
                return
            conn = Connection(user_a=ua.id, user_b=ub.id, created_at=now - timedelta(hours=1))
            db.add(conn)
            db.flush()
            db.add(ConnectMessage(connection_id=conn.id, sender_id=ub.id, recipient_id=ua.id, kind="text",
                                  original=text, source_lang=ub.language, translation=translation,
                                  target_lang=ua.language, sender_gender=ub.voice_gender))

        link("+919000000001", "+919000000002", "नमस्ते आशा, कैसी हो?", "नमस्ते आशा, कैसी हो?")
        link("+12025550143", "+34612345678", "Hola Emma, ¿cómo estás?", "Hi Emma, how are you?")

        for email, name, role, password in TEST_ADMINS:
            if not db.scalar(select(AdminUser.id).where(AdminUser.email == email)):
                db.add(AdminUser(email=email, name=name, role=role, password_hash=hash_password(password)))
                created.append(f"dashboard {role} {email}")
        db.commit()
    return created


if __name__ == "__main__":
    made = seed()
    print("Created:", ", ".join(made) if made else "nothing new (dummy data already exists)")
