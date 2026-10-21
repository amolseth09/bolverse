"""One-time codes by SMS, behind one small interface so the provider can be swapped with an env var.

    BOLVERSE_SMS_PROVIDER = console | android | msg91 | twilio_verify | twilio

- console        development only: prints the code to the server log, sends nothing. Refused in production.
- android        SMS Gateway for Android (sms-gate.app): sends from your own phone's SIM. Free apart from
                 your mobile plan. The default for now.
- msg91          MSG91 Flow API, for India at scale. Needs DLT registration of the sender ID and the template.
- twilio_verify  Twilio Verify: Twilio creates, sends and checks the code itself (no DLT work for you; costs
                 more per code in India).
- twilio         Plain Twilio SMS with our own code (kept for older setups).

Credentials come only from environment variables (see .env.example and docs/sms-gateway-setup.md).
Logs never contain a code or a full phone number, except the console provider, which exists to print
the code in development.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import settings
from .security import mask_phone

log = logging.getLogger("bolverse.auth")


class SmsError(RuntimeError):
    pass


@dataclass
class OtpProvider:
    """Providers either deliver a code we made (send) or make and check their own (start/check)."""
    name: str = "base"
    issues_own_code: bool = False

    def send(self, phone: str, code: str) -> None:  # we generate, they deliver
        raise NotImplementedError

    def start(self, phone: str) -> None:  # they generate and deliver
        raise NotImplementedError

    def check(self, phone: str, code: str) -> bool:  # they verify
        raise NotImplementedError


def _message(code: str) -> str:
    minutes = max(1, settings.otp_ttl_seconds // 60)
    return f"{code} is your Bolverse code. It expires in {minutes} minutes. Don't share it with anyone."


class ConsoleProvider(OtpProvider):
    def __init__(self):
        super().__init__("console")

    def send(self, phone: str, code: str) -> None:
        if settings.app_env == "production":
            raise SmsError("The console SMS provider is for development only.")
        log.warning("[dev] Bolverse code for %s: %s (not sent: console provider)", mask_phone(phone), code)


class AndroidGatewayProvider(OtpProvider):
    """SMS Gateway for Android (open source). Cloud relay, your own private server, or local mode."""

    def __init__(self):
        super().__init__("android")

    def send(self, phone: str, code: str) -> None:
        if not (settings.smsgate_username and settings.smsgate_password):
            raise SmsError("SMSGATE_USERNAME and SMSGATE_PASSWORD are not set.")
        r = httpx.post(settings.smsgate_url, auth=(settings.smsgate_username, settings.smsgate_password),
                       json={"textMessage": {"text": _message(code)}, "phoneNumbers": [phone]}, timeout=15)
        r.raise_for_status()


class Msg91Provider(OtpProvider):
    """MSG91 Flow API. The DLT-approved template must contain the variable named by MSG91_OTP_VAR."""

    def __init__(self):
        super().__init__("msg91")

    def send(self, phone: str, code: str) -> None:
        if not (settings.msg91_auth_key and settings.msg91_template_id):
            raise SmsError("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are not set.")
        r = httpx.post("https://control.msg91.com/api/v5/flow",
                       headers={"authkey": settings.msg91_auth_key, "accept": "application/json"},
                       json={"template_id": settings.msg91_template_id, "short_url": "0",
                             "recipients": [{"mobiles": phone.lstrip("+"), settings.msg91_otp_var: code}]},
                       timeout=10)
        r.raise_for_status()
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if body.get("type") == "error":
            raise SmsError(f"MSG91: {body.get('message', 'error')}")


class TwilioVerifyProvider(OtpProvider):
    """Twilio Verify. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID."""

    def __init__(self):
        super().__init__("twilio_verify", issues_own_code=True)

    def _url(self, path: str) -> str:
        if not (settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_verify_service_sid):
            raise SmsError("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID must be set.")
        return f"https://verify.twilio.com/v2/Services/{settings.twilio_verify_service_sid}/{path}"

    def start(self, phone: str) -> None:
        r = httpx.post(self._url("Verifications"), auth=(settings.twilio_account_sid, settings.twilio_auth_token),
                       data={"To": phone, "Channel": "sms"}, timeout=10)
        r.raise_for_status()

    def check(self, phone: str, code: str) -> bool:
        r = httpx.post(self._url("VerificationCheck"), auth=(settings.twilio_account_sid, settings.twilio_auth_token),
                       data={"To": phone, "Code": code}, timeout=10)
        if r.status_code == 404:  # expired or already used on Twilio's side
            return False
        r.raise_for_status()
        return r.json().get("status") == "approved"


class TwilioSmsProvider(OtpProvider):
    def __init__(self):
        super().__init__("twilio")

    def send(self, phone: str, code: str) -> None:
        sid = settings.twilio_account_sid
        r = httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                       auth=(sid, settings.twilio_auth_token),
                       data={"From": settings.twilio_from, "To": phone, "Body": _message(code)}, timeout=10)
        r.raise_for_status()


PROVIDERS = {"console": ConsoleProvider, "android": AndroidGatewayProvider, "msg91": Msg91Provider,
             "twilio_verify": TwilioVerifyProvider, "twilio": TwilioSmsProvider}
_override: OtpProvider | None = None  # tests put a fake provider here


def get_provider() -> OtpProvider:
    if _override is not None:
        return _override
    cls = PROVIDERS.get(settings.sms_provider)
    if cls is None:
        raise SmsError(f"Unknown BOLVERSE_SMS_PROVIDER: {settings.sms_provider}")
    return cls()


def deliver(phone: str, code: str | None) -> None:
    """Sends a code we generated, or asks a code-issuing provider (Twilio Verify) to start one."""
    provider = get_provider()
    try:
        if provider.issues_own_code:
            provider.start(phone)
        else:
            provider.send(phone, code or "")
    except httpx.HTTPError as exc:
        log.error("auth.sms_failed provider=%s phone=%s error=%s", provider.name, mask_phone(phone), type(exc).__name__)
        raise SmsError("SMS provider error") from exc


# Older name, kept for callers outside the auth routes.
def send_otp(phone: str, code: str) -> None:
    deliver(phone, code)
