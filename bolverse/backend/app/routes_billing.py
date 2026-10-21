"""Premium passes: 1 day, 1 week or 1 month. Prices and currency follow the user's phone number.

Ways to pay, cheapest first:
- upi      Direct UPI to your own UPI ID (BOLVERSE_UPI_ID): a QR code / "open UPI app" button for the exact
           amount. No gateway fee. The customer enters the 12-digit UPI transaction ID (UTR); you check it
           against your bank app and approve it in the dashboard, which activates the pass.
- cashfree Cards (Indian and international), UPI and net banking through Cashfree. Confirmed automatically.
- razorpay The same through Razorpay.
- dev      A simulated payment for testing (only while BOLVERSE_DEV_MODE=true).

Flow: the app calls POST /billing/checkout, opens pay_url in a browser, then refreshes GET /me.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import logging
import re
from datetime import timedelta
from typing import Literal
from urllib.parse import quote, urlencode

import httpx
import phonenumbers
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .entitlements import (PLAN_DAYS, PLAN_NAMES, Actor, currency_for, get_actor, payment_methods, price_label,
                           price_minor, problem, require_user)
from .models import Payment, Subscription, User
from .security import same, sign, utcnow

log = logging.getLogger("bolverse")
router = APIRouter(tags=["billing"])
public = APIRouter(tags=["billing (browser and webhooks)"])

UTR_RE = re.compile(r"^\d{12}$")


class CheckoutIn(BaseModel):
    plan: Literal["day", "week", "month"]
    method: Literal["upi", "card"] | None = None


def _pay_link(pid: str) -> str:
    return f"{settings.public_base_url}/billing/pay/{pid}?s={sign(pid)}"


def _done_link(pid: str) -> str:
    return f"{settings.public_base_url}/billing/done/{pid}?s={sign(pid)}"


def reference(pid: str) -> str:
    """Short reference shown to the customer and put in the UPI note, to match bank entries."""
    return "BV" + pid[:8].upper()


# ---------- Activation (idempotent and race-safe) ----------

def activate(db: Session, payment_id: str, reviewed_by: str | None = None) -> bool:
    now = utcnow()
    claimed = db.execute(
        update(Payment).where(Payment.id == payment_id, Payment.status.in_(("pending", "verifying")))
        .values(status="paid", paid_at=now, reviewed_by=reviewed_by)
    ).rowcount
    if claimed != 1:
        db.rollback()
        return False
    pay = db.get(Payment, payment_id)
    give_pass(db, pay.user_id, pay.plan, pay.id, PLAN_DAYS[pay.plan])
    db.commit()
    log.info("Payment %s activated %s for user %s", pay.id, pay.plan, pay.user_id)
    return True


def give_pass(db: Session, user_id: str, plan: str, payment_id: str, days: int) -> Subscription:
    """Adds a pass after any time the user already has: buying again extends, never overlaps."""
    now = utcnow()
    latest = db.scalar(select(Subscription.ends_at).where(Subscription.user_id == user_id,
                                                          Subscription.cancelled_at.is_(None))
                       .order_by(Subscription.ends_at.desc()).limit(1))
    start = max(now, latest) if latest else now
    sub = Subscription(user_id=user_id, plan=plan, starts_at=start, ends_at=start + timedelta(days=days),
                       payment_id=payment_id)
    db.add(sub)
    return sub


def reject(db: Session, payment_id: str, reason: str, reviewed_by: str | None) -> bool:
    n = db.execute(update(Payment).where(Payment.id == payment_id, Payment.status.in_(("pending", "verifying")))
                   .values(status="rejected", note=reason[:300], reviewed_by=reviewed_by)).rowcount
    db.commit()
    return n == 1


# ---------- Cashfree ----------

def _cf_base() -> str:
    return "https://api.cashfree.com/pg" if settings.cashfree_env == "production" else "https://sandbox.cashfree.com/pg"


def _cf_headers() -> dict:
    return {"x-client-id": settings.cashfree_app_id, "x-client-secret": settings.cashfree_secret_key,
            "x-api-version": "2023-08-01", "content-type": "application/json", "accept": "application/json"}


def _cf_phone(e164: str) -> str:
    try:
        num = phonenumbers.parse(e164, None)
        return str(num.national_number) if num.country_code == 91 else e164.lstrip("+")
    except phonenumbers.NumberParseException:
        return e164.lstrip("+")


def _cashfree_order(pay: Payment, user: User) -> str:
    r = httpx.post(f"{_cf_base()}/orders", headers=_cf_headers(), timeout=15, json={
        "order_id": pay.id,
        "order_amount": round(pay.amount_minor / 100, 2),
        "order_currency": pay.currency,
        "customer_details": {"customer_id": user.id, "customer_phone": _cf_phone(user.phone),
                             "customer_name": user.name[:60]},
        "order_meta": {"return_url": _done_link(pay.id),
                       "notify_url": f"{settings.public_base_url}/billing/webhook/cashfree"},
        "order_note": f"Bolverse Premium, {PLAN_NAMES[pay.plan]}",
    })
    r.raise_for_status()
    return r.json()["payment_session_id"]


def _cashfree_sync(db: Session, pay: Payment) -> None:
    """Ask Cashfree whether the order is paid (backstop for a missed webhook)."""
    if pay.provider != "cashfree" or pay.status != "pending":
        return
    try:
        r = httpx.get(f"{_cf_base()}/orders/{pay.id}", headers=_cf_headers(), timeout=10)
        r.raise_for_status()
        if r.json().get("order_status") == "PAID":
            activate(db, pay.id)
    except httpx.HTTPError as exc:
        log.warning("Cashfree check failed for %s: %s", pay.id, exc)


def verify_cashfree_webhook(body: bytes, timestamp: str, signature: str) -> bool:
    if not settings.cashfree_secret_key or not signature or not timestamp:
        return False
    digest = hmac.new(settings.cashfree_secret_key.encode(), timestamp.encode() + body, hashlib.sha256).digest()
    return same(base64.b64encode(digest).decode(), signature)


# ---------- Razorpay ----------

def _razorpay_order(pay: Payment) -> str:
    r = httpx.post("https://api.razorpay.com/v1/orders", auth=(settings.razorpay_key_id, settings.razorpay_key_secret),
                   json={"amount": pay.amount_minor, "currency": pay.currency, "receipt": pay.id,
                         "notes": {"payment_id": pay.id, "plan": pay.plan}}, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


def verify_razorpay_payment(order_id: str, payment_id: str, signature: str) -> bool:
    expected = hmac.new(settings.razorpay_key_secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return bool(signature) and same(expected, signature)


def verify_razorpay_webhook(body: bytes, signature: str) -> bool:
    expected = hmac.new(settings.razorpay_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    return bool(signature) and bool(settings.razorpay_webhook_secret) and same(expected, signature)


# ---------- API ----------

@router.post("/billing/checkout")
def checkout(body: CheckoutIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    currency = currency_for(user.country)
    methods = payment_methods(currency)
    method = body.method or (methods[0] if methods else None)
    if method not in methods:
        raise problem(503, "payments_unavailable", "This way of paying isn't available yet. Try another.")
    if method == "upi":
        provider = "upi"
    else:
        provider = settings.payment_provider_inr if currency == "INR" else settings.payment_provider_usd
    amount = price_minor(body.plan, currency)
    if amount <= 0:
        raise problem(422, "plan_unavailable", "This pass isn't on sale. Choose another one.")
    pay = Payment(user_id=user.id, plan=body.plan, currency=currency, amount_minor=amount, provider=provider,
                  method=method)
    db.add(pay)
    db.flush()
    try:
        if provider == "cashfree":
            pay.provider_ref = _cashfree_order(pay, user)
        elif provider == "razorpay":
            pay.provider_ref = _razorpay_order(pay)
    except httpx.HTTPError as exc:
        db.rollback()
        log.error("Checkout with %s failed: %s", provider, exc)
        raise problem(502, "payment_provider_error", "The payment service didn't respond. Try again in a moment.")
    db.commit()
    return {"payment_id": pay.id, "pay_url": _pay_link(pay.id), "plan": body.plan, "method": method,
            "currency": currency, "amount": amount / 100, "label": price_label(amount, currency),
            "reference": reference(pay.id)}


@router.get("/billing/payments")
def my_payments(db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    user = require_user(actor)
    rows = db.scalars(select(Payment).where(Payment.user_id == user.id, Payment.status != "pending")
                      .order_by(Payment.created_at.desc()).limit(50))
    return [{"id": p.id, "reference": reference(p.id), "plan": p.plan, "label": price_label(p.amount_minor, p.currency),
             "method": p.method, "status": p.status, "created_at": p.created_at.isoformat() + "Z",
             "note": p.note if p.status == "rejected" else ""} for p in rows]


# ---------- Browser pages ----------

PAGE_CSS = """
:root{--bg:#F5F6FA;--card:#fff;--ink:#0E1120;--muted:#5A6075;--line:#E1E4EE;--you:#2F3CF4;--them:#FFC53D;--bad:#C62828}
@media (prefers-color-scheme:dark){:root{--bg:#0A0C18;--card:#141829;--ink:#EEF0FA;--muted:#9BA2BE;--line:#262B42;--you:#6F7BFF}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px}
main{max-width:420px;width:100%}.brand{font-weight:800;font-size:22px;letter-spacing:-.03em;margin-bottom:24px}
.brand i{display:inline-block;width:14px;height:14px;border-radius:4px;background:var(--you);margin-right:4px}
.brand i+i{background:var(--them)}h1{font-size:26px;line-height:1.15;margin:0 0 8px;letter-spacing:-.02em}
p{color:var(--muted);line-height:1.5;margin:8px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin:16px 0}
.qr{background:#fff;border-radius:14px;padding:12px;width:240px;margin:8px auto;display:block}.qr svg{width:100%;height:auto;display:block}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:14px;padding:14px 20px;background:var(--you);color:#fff;
cursor:pointer;width:100%;display:block;text-align:center;text-decoration:none;margin-top:10px}
.btn.alt{background:transparent;color:var(--ink);border:1.5px solid var(--line)}
input{font:inherit;font-size:20px;letter-spacing:.12em;width:100%;padding:12px;border-radius:12px;border:1.5px solid var(--line);
background:var(--bg);color:var(--ink);text-align:center}.err{color:var(--bad);font-weight:600}
.row{display:flex;justify-content:space-between;gap:12px;margin:6px 0}.row b{font-variant-numeric:tabular-nums}
"""


def _page(title: str, body: str, refresh: int | None = None) -> HTMLResponse:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return HTMLResponse(
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
        f'content="width=device-width,initial-scale=1">{meta}<title>{html.escape(title)}</title>'
        f"<style>{PAGE_CSS}</style></head><body><main><div class=\"brand\"><i></i><i></i> bolverse</div>"
        f"{body}</main></body></html>"
    )


def _load(db: Session, pid: str, s: str) -> Payment:
    pay = db.get(Payment, pid)
    if pay is None or not same(sign(pid), s or ""):
        raise HTTPException(status_code=404, detail="Payment not found.")
    return pay


def upi_link(pay: Payment) -> str:
    params = {"pa": settings.upi_id, "pn": settings.upi_payee_name, "am": f"{pay.amount_minor / 100:.2f}",
              "cu": "INR", "tn": f"Bolverse {pay.plan} {reference(pay.id)}", "tr": reference(pay.id)}
    return "upi://pay?" + urlencode(params, quote_via=quote)


def qr_svg(data: str) -> str:
    import qrcode
    import qrcode.image.svg

    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, border=1, box_size=10)
    svg = img.to_string(encoding="unicode")
    return svg[svg.index("<svg"):]


def _upi_page(pay: Payment, s: str, error: str = "") -> HTMLResponse:
    label = price_label(pay.amount_minor, pay.currency)
    link = upi_link(pay)
    body = f"""<h1>Pay {label} by UPI</h1>
<p>Bolverse Premium, {PLAN_NAMES[pay.plan]}. One-time payment, no auto-renewal.</p>
<div class="card">
<div class="qr">{qr_svg(link)}</div>
<p style="text-align:center">Scan with any UPI app: PhonePe, Google Pay, Paytm, Amazon Pay, BHIM.</p>
<a class="btn" href="{html.escape(link)}">Open my UPI app</a>
<div class="row"><span>Pay to</span><b>{html.escape(settings.upi_id)}</b></div>
<div class="row"><span>Amount</span><b>{label}</b></div>
<div class="row"><span>Reference</span><b>{reference(pay.id)}</b></div>
</div>
<div class="card">
<p><b>After paying</b>, enter the 12-digit UPI transaction ID (UTR / UPI Ref No.) shown in your UPI app's payment details.</p>
<form method="post" action="{settings.public_base_url}/billing/upi/submit">
<input type="hidden" name="pid" value="{pay.id}"><input type="hidden" name="s" value="{html.escape(s)}">
<input name="utr" inputmode="numeric" maxlength="12" placeholder="123456789012" autocomplete="off" required>
{f'<p class="err">{html.escape(error)}</p>' if error else ''}
<button>I've paid: confirm</button></form>
<p>Premium starts as soon as we confirm it, usually within a few hours.</p></div>"""
    return _page("Pay by UPI", body)


@public.get("/billing/pay/{pid}", response_class=HTMLResponse)
def pay_page(pid: str, s: str = "", db: Session = Depends(get_db)):
    pay = _load(db, pid, s)
    if pay.status in ("paid", "verifying", "rejected"):
        return RedirectResponse(_done_link(pid), status_code=303)
    user = db.get(User, pay.user_id)
    label = price_label(pay.amount_minor, pay.currency)
    heading = f"<h1>Bolverse Premium, {PLAN_NAMES[pay.plan]}</h1><p>{label}, one-time payment. No auto-renewal.</p>"

    if pay.provider == "upi":
        return _upi_page(pay, s)

    if pay.provider == "cashfree":
        mode = "production" if settings.cashfree_env == "production" else "sandbox"
        script = f"""<button id="b">Pay {label}</button>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<script>var cf=Cashfree({{mode:"{mode}"}});function go(){{cf.checkout({{paymentSessionId:{json.dumps(pay.provider_ref)},redirectTarget:"_self"}});}}
document.getElementById('b').onclick=go;go();</script>"""
        return _page("Pay for Bolverse Premium", heading + script)

    if pay.provider == "razorpay":
        options = {
            "key": settings.razorpay_key_id, "amount": pay.amount_minor, "currency": pay.currency,
            "name": "Bolverse", "description": f"Premium, {PLAN_NAMES[pay.plan]}", "order_id": pay.provider_ref,
            "prefill": {"contact": user.phone if user else "", "name": user.name if user else ""},
            "theme": {"color": "#2F3CF4"},
        }
        script = f"""
<form id="f" method="post" action="{settings.public_base_url}/billing/razorpay/confirm">
<input type="hidden" name="pid" value="{pid}"><input type="hidden" name="s" value="{html.escape(s)}">
<input type="hidden" name="razorpay_payment_id"><input type="hidden" name="razorpay_order_id"><input type="hidden" name="razorpay_signature">
</form><button id="b">Pay {label}</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>var o={json.dumps(options)};o.handler=function(r){{var f=document.getElementById('f');
f.razorpay_payment_id.value=r.razorpay_payment_id;f.razorpay_order_id.value=r.razorpay_order_id;
f.razorpay_signature.value=r.razorpay_signature;f.submit();}};
var rz=new Razorpay(o);document.getElementById('b').onclick=function(){{rz.open();}};rz.open();</script>"""
        return _page("Pay for Bolverse Premium", heading + script)

    if pay.provider == "dev":
        form = (f'<p>Test mode: no money moves.</p>'
                f'<form method="post" action="{settings.public_base_url}/billing/dev/complete/{pid}">'
                f'<input type="hidden" name="s" value="{html.escape(s)}"><button>Simulate successful payment</button></form>')
        return _page("Test payment", heading + form)

    return RedirectResponse(_done_link(pid), status_code=303)


@public.post("/billing/upi/submit", response_class=HTMLResponse)
def upi_submit(pid: str = Form(...), s: str = Form(...), utr: str = Form(""), db: Session = Depends(get_db)):
    pay = _load(db, pid, s)
    if pay.provider != "upi":
        raise HTTPException(status_code=404, detail="Not found.")
    utr = re.sub(r"\s", "", utr)
    if pay.status != "pending":
        return RedirectResponse(_done_link(pid), status_code=303)
    if not UTR_RE.match(utr):
        return _upi_page(pay, s, "The UPI transaction ID has 12 digits. Check it in your UPI app's payment details.")
    if db.scalar(select(Payment.id).where(Payment.utr == utr)):
        return _upi_page(pay, s, "This transaction ID has already been used.")
    pay.utr, pay.status = utr, "verifying"
    db.commit()
    log.info("UPI payment %s submitted for verification (UTR ending %s)", pid, utr[-4:])
    return RedirectResponse(_done_link(pid), status_code=303)


@public.post("/billing/razorpay/confirm")
def razorpay_confirm(pid: str = Form(...), s: str = Form(...), razorpay_payment_id: str = Form(""),
                     razorpay_order_id: str = Form(""), razorpay_signature: str = Form(""),
                     db: Session = Depends(get_db)):
    pay = _load(db, pid, s)
    if pay.provider_ref == razorpay_order_id and verify_razorpay_payment(razorpay_order_id, razorpay_payment_id, razorpay_signature):
        activate(db, pid)
    return RedirectResponse(_done_link(pid), status_code=303)


@public.post("/billing/dev/complete/{pid}")
def dev_complete(pid: str, s: str = Form(...), db: Session = Depends(get_db)):
    pay = _load(db, pid, s)
    if pay.provider != "dev" or not settings.dev_mode:
        raise HTTPException(status_code=404, detail="Not found.")
    activate(db, pid)
    return RedirectResponse(_done_link(pid), status_code=303)


@public.get("/billing/done/{pid}", response_class=HTMLResponse)
def done_page(pid: str, s: str = "", db: Session = Depends(get_db)):
    pay = _load(db, pid, s)
    _cashfree_sync(db, pay)
    db.refresh(pay)
    if pay.status == "paid":
        sub = db.scalar(select(Subscription).where(Subscription.payment_id == pid))
        until = sub.ends_at.strftime("%d %b %Y, %H:%M UTC") if sub else ""
        return _page("You're on Premium", f"<h1>You're on Bolverse Premium</h1><p>Valid until {until}. "
                     "You can close this page and go back to Bolverse.</p>")
    if pay.status == "verifying":
        return _page("Confirming your payment", f"<h1>Thanks! We're confirming your payment</h1><p>Reference "
                     f"<b>{reference(pid)}</b>. Premium starts as soon as it's confirmed, usually within a few "
                     "hours. You can close this page; Bolverse updates by itself.</p>", refresh=30)
    if pay.status == "rejected":
        why = f" Reason: {html.escape(pay.note)}." if pay.note else ""
        return _page("Payment not confirmed", f"<h1>We couldn't confirm this payment</h1><p>{why} If money left "
                     f"your account, contact support with reference <b>{reference(pid)}</b>.</p>")
    return _page("Waiting for payment", "<h1>Waiting for your payment</h1><p>This page checks again every few "
                 f"seconds. If you closed the payment window, nothing was charged.</p>"
                 f'<a class="btn alt" href="{_pay_link(pid)}">Try paying again</a>', refresh=4)


# ---------- Webhooks ----------

@public.post("/billing/webhook/cashfree")
async def cashfree_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if not verify_cashfree_webhook(body, request.headers.get("x-webhook-timestamp", ""),
                                   request.headers.get("x-webhook-signature", "")):
        raise HTTPException(status_code=400, detail="Bad signature.")
    data = json.loads(body).get("data", {})
    order_id = (data.get("order") or {}).get("order_id")
    status = (data.get("payment") or {}).get("payment_status")
    if order_id and status == "SUCCESS":
        pay = db.get(Payment, order_id)
        if pay and pay.provider == "cashfree":
            activate(db, pay.id)
    return {"ok": True}


@public.post("/billing/webhook/razorpay")
async def razorpay_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if not verify_razorpay_webhook(body, request.headers.get("x-razorpay-signature", "")):
        raise HTTPException(status_code=400, detail="Bad signature.")
    event = json.loads(body)
    if event.get("event") in {"payment.captured", "order.paid"}:
        order_id = event.get("payload", {}).get("payment", {}).get("entity", {}).get("order_id")
        pay = db.scalar(select(Payment).where(Payment.provider == "razorpay", Payment.provider_ref == order_id))
        if pay:
            activate(db, pay.id)
    return {"ok": True}
