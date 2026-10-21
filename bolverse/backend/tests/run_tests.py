"""End-to-end tests for the Bolverse server, with a stand-in AI engine (no GPU or models needed).

    cd backend && python tests/run_tests.py            # once
    cd backend && python tests/run_tests.py --loop 5   # five times, each on a fresh database

Covers: login and sign-up, Ask, daily limit, plans and prices, direct UPI (QR, transaction ID, approve,
reject, duplicate IDs), card checkout in test mode, QR connect (one-time codes, a new code cancels the old
one), translated chat between two phones, delivery and deletion, disconnect, blocked users, push tokens,
the admin dashboard with all four roles, and the audit log.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import os
import re
import sys
import tempfile
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
DB_DIR = tempfile.mkdtemp(prefix="bolverse-test-")
os.environ.update(
    BOLVERSE_DATABASE_URL=f"sqlite:///{DB_DIR}/test.db", BOLVERSE_SECRET_KEY="test-secret", BOLVERSE_DEV_MODE="true",
    BOLVERSE_OTP_RESEND_SECONDS="0", BOLVERSE_UPI_ID="bolverse@okhdfcbank", BOLVERSE_PUBLIC_BASE_URL="http://testserver",
    BOLVERSE_PAYMENT_PROVIDER_INR="dev", BOLVERSE_PAYMENT_PROVIDER_USD="dev", BOLVERSE_AI_URL="",
    BOLVERSE_FREE_TRANSLATIONS_PER_DAY="50", BOLVERSE_DASHBOARD_DIR=os.path.join(DB_DIR, "none"),
    CASHFREE_SECRET_KEY="cf-secret", APP_ENV="development",
    # This suite covers the day/week/month passes and the daily allowance; the defaults (week/month only,
    # 50 in total) are covered by tests/test_auth_otp.py.
    BOLVERSE_PRICE_INR_DAY="2000", BOLVERSE_PRICE_INR_WEEK="10000", BOLVERSE_PRICE_INR_MONTH="25000",
    BOLVERSE_PRICE_USD_DAY="99", BOLVERSE_PRICE_USD_WEEK="399", BOLVERSE_PRICE_USD_MONTH="999",
)


class FakeAI:
    """Predictable answers: 'translates' by tagging the text with the target language."""
    remote = False

    def transcribe(self, audio, filename, lang, hints):
        return {"text": "मैं बाज़ार जा रहा हूँ" if lang.code.startswith("hi") else "I am going to the market",
                "speaker_gender": "male"}

    def translate(self, text, src, tgt):
        return f"[{tgt.code}] {text}"

    def to_native(self, text, lang):
        return "मैं थक गई हूँ" if lang.code.startswith("hi") else text

    def polish(self, source_text, translation, src, tgt, gender, reader, readings):
        out = translation + (" (f)" if gender == "female" else " (m)" if gender == "male" else "")
        return {"translation": out, "native_reading": "reading" if readings else "",
                "english_reading": "reading-en" if readings else ""}

    def speak(self, text, lang, rate, gender):
        return (b"RIFF0000WAVEfmt ", gender or "female")

    def voice_options(self, lang):
        return {"available": True, "genders": ["female", "male"]}

    def status(self):
        return {"mode": "test", "device": "cpu", "loaded": {}}

    def preload(self):
        pass


from app import ai as ai_module  # noqa: E402

ai_module._engine = FakeAI()

from fastapi.testclient import TestClient  # noqa: E402

from app import main, routes_billing  # noqa: E402
from app.db import Base, engine  # noqa: E402

import logging
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("bolverse").setLevel(logging.ERROR)
logging.getLogger("httpx").setLevel(logging.WARNING)
RESULTS = {"pass": 0, "fail": 0}


def check(name: str, cond: bool, info: object = "") -> None:
    if cond:
        RESULTS["pass"] += 1
    else:
        RESULTS["fail"] += 1
        print(f"  FAIL {name} {str(info)[:300]}")


def device(n: int) -> dict:
    return {"X-Device-Id": f"test-device-{n:04d}"}


def login(c: TestClient, phone: str, dev: int) -> dict:
    r = c.post("/auth/otp", json={"phone": phone}, headers=device(dev))
    assert r.status_code == 200, r.text
    r = c.post("/auth/verify", json={"phone": phone, "code": "123456"}, headers=device(dev))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "signed_in", body
    return {**device(dev), "Authorization": f"Bearer {body['access_token']}"}


def admin_login(c: TestClient, email: str, password: str) -> dict:
    r = c.post("/admin/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def run_once() -> None:
    Base.metadata.drop_all(engine)
    with TestClient(main.app) as c:  # startup creates tables and dummy data
        # ---------- health and login ----------
        check("health", c.get("/health").json()["status"] == "ok")
        r = c.post("/ask", data={"source": "hi-IN", "target": "es-ES", "text": "x"}, headers=device(1))
        check("guests can ask without logging in", r.status_code == 200, r.text)

        asha = login(c, "+91 90000 00001", 1)
        me = c.get("/me", headers=asha).json()
        check("asha free", me["plan"] == "free" and me["usage"]["today"] == 30, me)
        check("three plans in INR", [p["label"] for p in me["prices"]] == ["₹20", "₹100", "₹250"], me["prices"])
        check("payment methods INR", me["payment_methods"] == ["upi", "card"], me.get("payment_methods"))

        emma = login(c, "+1 202 555 0143", 2)
        me_e = c.get("/me", headers=emma).json()
        check("three plans in USD", [p["label"] for p in me_e["prices"]] == ["$0.99", "$3.99", "$9.99"], me_e["prices"])
        check("no UPI abroad", me_e["payment_methods"] == ["card"], me_e["payment_methods"])

        # new user sign-up
        r = c.post("/auth/otp", json={"phone": "+91 98111 22334"}, headers=device(3)).json()
        check("new number gets dev code", not r["registered"] and r.get("dev_code"), r)
        v = c.post("/auth/verify", json={"phone": "+919811122334", "code": r["dev_code"]}, headers=device(3)).json()
        check("new user", v["status"] == "new_user", v)
        s = c.post("/auth/complete", json={"signup_token": v["signup_token"], "name": "Kavya Rao", "dob": "1997-06-15",
                                           "gender": "female", "language": "hi-IN"}, headers=device(3)).json()
        check("signed up", s["status"] == "signed_in" and s["account"]["user"]["gender"] == "female", s)
        r = c.post("/auth/verify", json={"phone": "+919811122334", "code": "000000"}, headers=device(3))
        check("wrong code refused", r.status_code == 400, r.text)

        # blocked user can't sign in
        r = c.post("/auth/otp", json={"phone": "+919000000007"}, headers=device(4))
        r = c.post("/auth/verify", json={"phone": "+919000000007", "code": "123456"}, headers=device(4))
        check("blocked user refused", r.status_code == 403 and r.json()["detail"]["code"] == "account_blocked", r.text)

        # ---------- Ask ----------
        a = c.post("/ask", data={"source": "hi-IN", "target": "es-ES", "text": "main thak gayi hoon"}, headers=asha).json()
        check("ask hinglish", a["source_text"] == "मैं थक गई हूँ" and a["translation"].endswith("(f)")
              and a["english_reading"] == "reading-en", a)
        check("usage counted", c.get("/me", headers=asha).json()["usage"]["today"] == 31)

        vikram = login(c, "+91 90000 00004", 5)
        r = c.post("/translate", json={"text": "hi", "source": "en-US", "target": "pa-IN", "speaker": "me"}, headers=vikram)
        check("daily limit", r.status_code == 402 and r.json()["detail"]["code"] == "quota_exceeded", r.text)

        # ---------- Direct UPI ----------
        co = c.post("/billing/checkout", json={"plan": "week", "method": "upi"}, headers=vikram).json()
        check("upi checkout", co["method"] == "upi" and co["label"] == "₹100" and co["reference"].startswith("BV"), co)
        pid, sig = co["payment_id"], re.search(r"s=([0-9a-f]+)", co["pay_url"]).group(1)
        page = c.get(f"/billing/pay/{pid}", params={"s": sig}).text
        check("upi page has QR and link", "<svg" in page and "upi://pay?pa=bolverse%40okhdfcbank" in page
              and "am=100.00" in page and co["reference"] in page, page[:200])
        r = c.post("/billing/upi/submit", data={"pid": pid, "s": sig, "utr": "12345"})
        check("short UTR refused", "12 digits" in r.text)
        r = c.post("/billing/upi/submit", data={"pid": pid, "s": sig, "utr": "612345678901"})
        check("used UTR refused", "already been used" in r.text, r.text[-300:])
        r = c.post("/billing/upi/submit", data={"pid": pid, "s": sig, "utr": "777766665555"}, follow_redirects=True)
        check("UTR accepted", "confirming your payment" in r.text, r.text[-300:])
        check("still free until approved", c.get("/me", headers=vikram).json()["plan"] == "free")
        r = c.post("/billing/upi/submit", data={"pid": pid, "s": sig, "utr": "777766665556"}, follow_redirects=True)
        check("can't resubmit", "confirming your payment" in r.text)
        check("bad signature", c.get(f"/billing/pay/{pid}", params={"s": "nope"}).status_code == 404)

        # ---------- Card (test mode) ----------
        co2 = c.post("/billing/checkout", json={"plan": "day", "method": "card"}, headers=emma).json()
        check("card checkout usd", co2["label"] == "$0.99" and co2["method"] == "card", co2)
        r = c.post("/billing/checkout", json={"plan": "day", "method": "upi"}, headers=emma)
        check("upi not offered abroad", r.status_code == 503, r.text)
        sig2 = re.search(r"s=([0-9a-f]+)", co2["pay_url"]).group(1)
        c.post(f"/billing/dev/complete/{co2['payment_id']}", data={"s": sig2})
        me_e = c.get("/me", headers=emma).json()
        check("day pass active", me_e["plan"] == "premium" and me_e["subscription"]["plan"] == "day", me_e)
        co3 = c.post("/billing/checkout", json={"plan": "week", "method": "card"}, headers=emma).json()
        c.post(f"/billing/dev/complete/{co3['payment_id']}", data={"s": re.search(r's=([0-9a-f]+)', co3['pay_url']).group(1)})
        days = c.get("/me", headers=emma).json()["subscription"]["days_left"]
        check("week added after day (8 days)", days == 8, days)

        # Cashfree webhook signature check
        body = b'{"data":{"order":{"order_id":"x"},"payment":{"payment_status":"SUCCESS"}}}'
        ts = str(int(time.time()))
        good = base64.b64encode(hmac.new(b"cf-secret", ts.encode() + body, hashlib.sha256).digest()).decode()
        check("cashfree signature ok", routes_billing.verify_cashfree_webhook(body, ts, good))
        check("cashfree signature bad", not routes_billing.verify_cashfree_webhook(body, ts, good[:-2] + "AA"))
        r = c.post("/billing/webhook/cashfree", content=body, headers={"x-webhook-timestamp": ts, "x-webhook-signature": "bad"})
        check("cashfree webhook rejects bad signature", r.status_code == 400)

        # ---------- Connect ----------
        rahul = login(c, "+91 90000 00002", 6)
        inbox = c.get("/connect/inbox", headers=asha).json()["messages"]
        check("seeded message waiting for Asha", any(m["original"].startswith("नमस्ते") for m in inbox), inbox)
        c.post("/connect/ack", json={"ids": [m["id"] for m in inbox]}, headers=asha)
        check("acked messages deleted", c.get("/connect/inbox", headers=asha).json()["messages"] == [])

        inv1 = c.post("/connect/invite", headers=emma).json()
        check("invite has QR and code", inv1["qr"].startswith("bolverse://connect?t=") and len(inv1["code"]) == 6, inv1)
        inv2 = c.post("/connect/invite", headers=emma).json()
        r = c.post("/connect/join", json={"token": inv1["token"]}, headers=asha)
        check("old QR cancelled by new one", r.status_code == 404 and r.json()["detail"]["code"] == "invite_invalid", r.text)
        r = c.post("/connect/join", json={"token": inv2["qr"]}, headers=emma)
        check("own QR refused", r.json()["detail"]["code"] == "invite_self", r.text)
        j = c.post("/connect/join", json={"token": inv2["qr"]}, headers=asha).json()
        cid = j["connection"]["id"]
        check("joined", j["connection"]["peer"]["name"] == "Emma Johnson", j)
        r = c.post("/connect/join", json={"token": inv2["token"]}, headers=rahul)
        check("QR works only once", r.status_code == 410 and r.json()["detail"]["code"] == "invite_used", r.text)
        ev = c.get("/connect/inbox", headers=emma).json()["messages"]
        check("emma told asha joined", any(m["kind"] == "joined" and m["peer"]["name"] == "Asha Verma" for m in ev), ev)
        c.post("/connect/ack", json={"ids": [m["id"] for m in ev]}, headers=emma)

        sent = c.post(f"/connect/{cid}/messages", data={"text": "main bazaar ja rahi hoon"}, headers=asha).json()
        check("asha's message translated to English, female wording", sent["from_me"] and sent["target"] == "en-US"
              and sent["translation"].startswith("[en-US]") and sent["translation"].endswith("(f)"), sent)
        r = c.post(f"/connect/{cid}/messages", files={"audio": ("a.webm", b"\x1a\x45\xdf\xa3" * 100, "audio/webm")}, headers=emma)
        voice = r.json()
        check("emma's voice message to Hindi", r.status_code == 200 and voice["kind"] == "voice"
              and voice["translation"].startswith("[hi-IN]"), r.text)
        got = c.get("/connect/inbox", headers=emma).json()["messages"]
        check("emma receives asha's message", len(got) == 1 and got[0]["original"] == "मैं थक गई हूँ", got)
        got_a = c.get("/connect/inbox", headers=asha).json()["messages"]
        check("asha receives emma's voice", len(got_a) == 1 and got_a[0]["kind"] == "voice", got_a)
        lst = c.get("/connect", headers=asha).json()
        check("connection listed with waiting count", any(x["id"] == cid and x["waiting"] == 1 for x in lst), lst)
        r = c.post(f"/connect/{cid}/messages", data={"text": "hi"}, headers=rahul)
        check("outsider can't post", r.status_code == 404, r.text)
        c.post("/connect/ack", json={"ids": [m["id"] for m in got]}, headers=asha)  # not Asha's: ignored
        check("can't delete someone else's messages", len(c.get("/connect/inbox", headers=emma).json()["messages"]) == 1)

        c.post(f"/connect/{cid}/disconnect", headers=emma)
        r = c.post(f"/connect/{cid}/messages", data={"text": "hello?"}, headers=asha)
        check("no messages after disconnect", r.status_code == 409 and r.json()["detail"]["code"] == "disconnected", r.text)
        got_a = c.get("/connect/inbox", headers=asha).json()["messages"]
        check("asha still gets the message sent before the disconnect, then the notice",
              [m["kind"] for m in got_a] == ["voice", "ended"], got_a)
        check("chat gone from list", all(x["id"] != cid for x in c.get("/connect", headers=asha).json()))
        r = c.post("/connect/join", json={"token": inv2["token"]}, headers=asha)
        check("reconnect needs new QR", r.status_code == 410, r.text)
        inv3 = c.post("/connect/invite", headers=emma).json()
        j2 = c.post("/connect/join", json={"code": inv3["code"].lower()}, headers=asha).json()
        check("reconnect by typed code", j2["connection"]["id"] != cid, j2)

        r = c.post("/push/register", json={"token": "fcm-token-abcdefghijkl", "platform": "android"}, headers=asha)
        check("push token saved", r.json()["ok"] is True, r.text)

        # ---------- Admin dashboard ----------
        r = c.get("/admin/stats")
        check("dashboard needs sign-in", r.status_code == 401)
        r = c.post("/admin/login", json={"email": "owner@bolverse.test", "password": "wrong"})
        check("wrong admin password", r.status_code == 401)
        owner = admin_login(c, "owner@bolverse.test", "Owner@12345")
        finance = admin_login(c, "finance@bolverse.test", "Finance@12345")
        support = admin_login(c, "support@bolverse.test", "Support@12345")
        admin = admin_login(c, "admin@bolverse.test", "Admin@12345")

        st = c.get("/admin/stats", headers=owner).json()
        check("stats", st["users"] >= 11 and st["upi_to_verify"] >= 2 and len(st["daily"]) == 14, st)
        check("support can't see stats", c.get("/admin/stats", headers=support).status_code == 403)
        us = c.get("/admin/users", params={"q": "Vikram"}, headers=support).json()
        check("support can search users", us["total"] == 1 and us["users"][0]["plan"] == "free", us)
        vid = us["users"][0]["id"]
        check("support can't grant", c.post(f"/admin/users/{vid}/grant", json={"plan": "day"}, headers=support).status_code == 403)
        check("finance can't grant", c.post(f"/admin/users/{vid}/grant", json={"plan": "day"}, headers=finance).status_code == 403)
        check("admin can't manage admins", c.get("/admin/admins", headers=admin).status_code == 403)

        pend = c.get("/admin/payments", params={"status": "verifying"}, headers=finance).json()
        mine = [p for p in pend["payments"] if p["utr"] == "777766665555"]
        check("finance sees UPI to verify", len(mine) == 1 and mine[0]["user_name"] == "Vikram Singh", pend)
        found = c.get("/admin/payments", params={"q": "777766665555"}, headers=finance).json()
        check("search payments by UTR", found["total"] == 1, found)
        check("support can't approve", c.post(f"/admin/payments/{pid}/approve", headers=support).status_code == 403)
        r = c.post(f"/admin/payments/{pid}/approve", headers=finance)
        check("finance approves", r.status_code == 200, r.text)
        mv = c.get("/me", headers=vikram).json()
        check("vikram now premium for a week", mv["plan"] == "premium" and mv["subscription"]["plan"] == "week", mv)
        check("approve twice refused", c.post(f"/admin/payments/{pid}/approve", headers=finance).status_code == 409)

        arjun_pay = [p for p in pend["payments"] if p["utr"] == "612345678901"][0]
        r = c.post(f"/admin/payments/{arjun_pay['id']}/reject", json={"reason": "No credit received"}, headers=admin)
        check("admin rejects", r.status_code == 200, r.text)

        r = c.post(f"/admin/users/{vid}/grant", json={"plan": "month", "note": "Goodwill"}, headers=admin).json()
        check("admin grants a month", r["ok"], r)
        det = c.get(f"/admin/users/{vid}", headers=admin).json()
        check("user detail shows passes and payments", len(det["subscriptions"]) >= 2 and len(det["payments"]) >= 2, det)
        sub_id = [s for s in det["subscriptions"] if s["plan"] == "month" and s["state"] != "ended"][0]["id"]
        c.post(f"/admin/users/{vid}/cancel-subscription", json={"subscription_id": sub_id}, headers=admin)
        det = c.get(f"/admin/users/{vid}", headers=admin).json()
        check("cancelled", any(s["id"] == sub_id and s["state"] == "cancelled" for s in det["subscriptions"]), det)

        aid = c.get("/admin/users", params={"q": "Asha"}, headers=admin).json()["users"][0]["id"]
        c.post(f"/admin/users/{aid}/block", json={"blocked": True}, headers=admin)
        r = c.get("/me", headers=asha)
        check("blocked user signed out", r.status_code in (401, 403), r.text)
        c.post(f"/admin/users/{aid}/block", json={"blocked": False}, headers=admin)

        new = c.post("/admin/admins", json={"email": "helper@bolverse.test", "name": "Helper", "role": "support",
                                            "password": "Helper12345x"}, headers=owner).json()
        check("owner adds support user", new["role"] == "support", new)
        check("weak password refused", c.post("/admin/admins", json={"email": "x@bolverse.test", "name": "X", "role": "support",
                                                                     "password": "aaaaaaaaaa"}, headers=owner).status_code == 422)
        helper = admin_login(c, "helper@bolverse.test", "Helper12345x")
        c.patch(f"/admin/admins/{new['id']}", json={"active": False}, headers=owner)
        check("disabled admin signed out", c.get("/admin/me", headers=helper).status_code == 401)
        own = [a for a in c.get("/admin/admins", headers=owner).json() if a["role"] == "owner"][0]
        r = c.patch(f"/admin/admins/{own['id']}", json={"role": "support"}, headers=owner)
        check("last owner protected", r.status_code == 409, r.text)
        for _ in range(5):
            c.post("/admin/login", json={"email": "support@bolverse.test", "password": "bad"})
        r = c.post("/admin/login", json={"email": "support@bolverse.test", "password": "Support@12345"})
        check("locked after 5 wrong passwords", r.status_code == 429, r.text)
        log = c.get("/admin/audit", headers=owner).json()
        actions = {e["action"] for e in log["entries"]}
        check("audit log", {"payment.approve", "payment.reject", "subscription.grant", "user.block", "admin.create"} <= actions, actions)
        check("finance can't read audit", c.get("/admin/audit", headers=finance).status_code == 403)

        # ---------- A longer conversation: 40 messages back and forth ----------
        priya = login(c, "+91 90000 00003", 7)   # Malayalam, Premium
        lucia = login(c, "+34 612 345 678", 8)    # Spanish, Premium
        inv = c.post("/connect/invite", headers=priya).json()
        conv = c.post("/connect/join", json={"token": inv["qr"]}, headers=lucia).json()["connection"]["id"]
        for side in (priya, lucia):
            pending = c.get("/connect/inbox", headers=side).json()["messages"]
            c.post("/connect/ack", json={"ids": [m["id"] for m in pending]}, headers=side)
        got_p, got_l = [], []
        for i in range(20):
            c.post(f"/connect/{conv}/messages", data={"text": f"message {i} from priya"}, headers=priya)
            c.post(f"/connect/{conv}/messages", data={"text": f"message {i} from lucia"}, headers=lucia)
            if i % 5 == 4:  # phones collect every few messages, like the 3-second check
                for side, bucket in ((priya, got_p), (lucia, got_l)):
                    pending = c.get("/connect/inbox", headers=side).json()["messages"]
                    bucket.extend(pending)
                    c.post("/connect/ack", json={"ids": [m["id"] for m in pending]}, headers=side)
        check("lucia got all 20, in order, in Spanish", [m["original"] for m in got_l] == [f"message {i} from priya" for i in range(20)]
              and all(m["translation"].startswith("[es-ES]") for m in got_l), [m["original"] for m in got_l][:3])
        check("priya got all 20, in order, in Malayalam", [m["original"] for m in got_p] == [f"message {i} from lucia" for i in range(20)]
              and all(m["translation"].startswith("[ml-IN]") for m in got_p), [m["original"] for m in got_p][:3])
        check("nothing left on the server", not c.get("/connect/inbox", headers=priya).json()["messages"]
              and not c.get("/connect/inbox", headers=lucia).json()["messages"])
        from app.db import SessionLocal
        from app.models import ConnectMessage
        with SessionLocal() as db:
            rows = db.query(ConnectMessage).filter(ConnectMessage.connection_id == conv).all()
            check("every message marked delivered (kept briefly for the other devices)",
                  rows and all(m.delivered_at is not None for m in rows), len(rows))


def main_() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", type=int, default=1)
    args = ap.parse_args()
    for i in range(1, args.loop + 1):
        before = RESULTS["fail"]
        try:
            run_once()
        except Exception:
            RESULTS["fail"] += 1
            traceback.print_exc()
        print(f"Round {i}: {'ok' if RESULTS['fail'] == before else 'FAILED'} "
              f"({RESULTS['pass']} checks passed so far, {RESULTS['fail']} failed)")
    print(f"TOTAL: {RESULTS['pass']} passed, {RESULTS['fail']} failed over {args.loop} round(s)")
    return 0 if RESULTS["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main_())
