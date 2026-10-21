"""Bolverse API.

    uvicorn app.main:app --host 0.0.0.0 --port 8000        (docs at /docs)

Everything needs a signed-in user (except when BOLVERSE_ACCOUNTS_ENABLED=false). The AI runs in this
process, or on a separate AI worker when BOLVERSE_AI_URL is set (see app/ai.py).
"""
from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from . import routes_admin, routes_auth, routes_billing, routes_connect, routes_learning
from .ai import AIUnavailable, get_ai
from .audio import AudioError
from .config import settings
from .db import get_db, init_db
from .entitlements import Actor, check_translation_quota, get_actor, problem, record_translation
from .languages import LANGUAGES, Language, find, gender_voices
from .schemas import AskOut, ConverseOut, TranslateIn, TranslateOut, TTSIn
from .services.textutil import is_romanized, romanize
from .services.vocab import apply_vocabulary

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bolverse")
ai = get_ai()

app = FastAPI(title="Bolverse API", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["X-Voice-Gender"])


def _https_required() -> bool:
    return settings.require_https or settings.app_env == "production"


_LOCAL = {"127.0.0.1", "::1", "localhost", "testclient"}


@app.middleware("http")
async def _transport_security(request: Request, call_next):
    """TLS only: plain-HTTP requests are refused (the reverse proxy terminates TLS and says so in
    X-Forwarded-Proto). Health checks from the machine itself are allowed. HSTS tells browsers to never
    try plain HTTP again."""
    if _https_required():
        proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip().lower()
        host = request.client.host if request.client else ""
        if proto != "https" and not (request.url.path == "/health" and host in _LOCAL):
            return JSONResponse(status_code=403, content={"detail": {"code": "https_required",
                                                                     "message": "Use https:// to connect to Bolverse."}})
    response = await call_next(request)
    if _https_required():
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@app.exception_handler(AudioError)
async def _audio_error(_: Request, exc: AudioError):
    return JSONResponse(status_code=422, content={"detail": {"code": "audio", "message": str(exc)}})


@app.exception_handler(AIUnavailable)
async def _ai_down(_: Request, exc: AIUnavailable):
    return JSONResponse(status_code=503, content={"detail": {"code": "ai_unavailable", "message": str(exc)}})


@app.exception_handler(HTTPException)
async def _http_error(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


def require_key(x_api_key: str | None = Header(default=None), api_key: str | None = Query(default=None)) -> None:
    # The query parameter exists for audio players, which can't send headers.
    if settings.api_key and (x_api_key or api_key) != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key. Set it in Profile.")


api = APIRouter(dependencies=[Depends(require_key)])


def lang(code: str) -> Language:
    found = find(code)
    if not found:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {code}")
    return found


def read_audio(upload: UploadFile) -> bytes:
    data = upload.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Recording is larger than {settings.max_upload_mb} MB.")
    return data


def hints(db: Session, actor: Actor, language: str) -> list[str]:
    try:
        return routes_learning.terms_for(db, actor, language)
    except Exception:
        return []


def understood(text: str, src: Language) -> str:
    """Hinglish (or any language typed in English letters) -> its own script."""
    return ai.to_native(text, src) if is_romanized(text, src) else text


@app.get("/health")
def health():
    return {"status": "ok", "accounts": settings.accounts_enabled, "learning": settings.learning_enabled,
            "auth": bool(settings.api_key), "ai": ai.status(),
            # kept for the apps' "Test connection" button
            "device": ai.status().get("device", "remote"), "loaded": ai.status().get("loaded", {})}


@api.get("/languages")
def languages():
    return [{"code": l.code, "name": l.name, "native": l.native, "hello": l.hello, "region": l.region,
             "latin": l.latin, "speech_input": l.speech_input, "voice_genders": gender_voices(l)} for l in LANGUAGES]


# ---------- Ask: "how do I say this in ...?" ----------

@api.post("/ask", response_model=AskOut)
def ask(source: str = Form(...), target: str = Form(...), text: str | None = Form(None, max_length=1000),
        audio: UploadFile | None = File(None), db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """Speak or type in your language; get the sentence in the target language, how to read it in your
    own script and in English letters, worded for your gender."""
    src, tgt = lang(source), lang(target)
    check_translation_quota(actor)
    if audio is not None:
        heard = ai.transcribe(read_audio(audio), audio.filename, src, hints(db, actor, src.code))["text"]
    elif text and text.strip():
        heard = text.strip()
    else:
        raise problem(422, "empty", "Say or type something to translate.")
    if not heard:
        raise problem(422, "nothing_heard", "I didn't catch that. Try again a little closer to the mic.")
    source_text = understood(heard, src)
    translation = ai.translate(source_text, src, tgt) if src.nllb != tgt.nllb else source_text
    gender = actor.voice_gender
    reader = find(actor.user.language) if actor.user and actor.user.language else src  # the user's own script
    out = ai.polish(source_text, translation, src, tgt, gender, reader or src, True)
    record_translation(db, actor)
    return AskOut(question=heard, source_text=source_text, translation=out["translation"],
                  native_reading=out["native_reading"], english_reading=out["english_reading"],
                  target=tgt.code, voice_gender=gender)


# ---------- Converse: two people talking ----------

def _speaker_gender(actor: Actor, speaker: str, override: str | None, guessed: str | None = None) -> str | None:
    if speaker == "me":
        return actor.voice_gender or override
    return override or guessed


@api.post("/translate", response_model=TranslateOut)
def translate_text(body: TranslateIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    src, tgt = lang(body.source), lang(body.target)
    check_translation_quota(actor)
    source_text = understood(body.text, src)
    text = ai.translate(source_text, src, tgt)
    gender = _speaker_gender(actor, body.speaker, body.speaker_gender)
    text = ai.polish(source_text, text, src, tgt, gender, None, False)["translation"]
    record_translation(db, actor)
    return TranslateOut(translation=text, romanized=romanize(text, tgt), source_text=source_text)


@api.post("/converse", response_model=ConverseOut)
def converse(audio: UploadFile = File(...), source: str = Form(...), target: str = Form(...),
             speaker: str = Form("me"), speaker_gender: str | None = Form(None),
             db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """One round trip for the interpreter. speaker is "me" (the user) or "them" (the other person);
    for "them", speaker_gender comes from the app's ♂/♀ toggle, or is guessed from voice pitch."""
    src, tgt = lang(source), lang(target)
    check_translation_quota(actor)
    heard = ai.transcribe(read_audio(audio), audio.filename, src, hints(db, actor, src.code) if speaker == "me" else [])
    if not heard["text"]:
        raise problem(422, "nothing_heard", "Nothing was heard. Try again a little closer to the mic.")
    override = speaker_gender if speaker_gender in ("male", "female") else None
    gender = _speaker_gender(actor, speaker, override, heard.get("speaker_gender"))
    text = ai.translate(heard["text"], src, tgt)
    text = ai.polish(heard["text"], text, src, tgt, gender, None, False)["translation"]
    record_translation(db, actor)
    return ConverseOut(original=heard["text"], translation=text, romanized=romanize(text, tgt),
                       speaker_gender=gender)


# ---------- Voices ----------

@api.get("/voices/{code}")
def voice(code: str, actor: Actor = Depends(get_actor)):
    return {"language": code, **ai.voice_options(lang(code))}


def _speech(text: str, code: str, rate: float, gender: str | None) -> Response:
    spoken = ai.speak(text, lang(code), rate, gender)
    if spoken is None:
        raise HTTPException(status_code=404, detail="No server voice for this language; use the device voice.")
    wav, used = spoken
    return Response(content=wav, media_type="audio/wav",
                     headers={"Cache-Control": "private, max-age=3600", "X-Voice-Gender": used})


@api.get("/tts")
def tts_get(text: str = Query(..., min_length=1, max_length=1500), language: str = Query(...),
            rate: float = Query(1.0, ge=0.5, le=2.0), gender: str | None = Query(None, pattern="^(male|female)$"),
            actor: Actor = Depends(get_actor)):
    return _speech(text, language, rate, gender or actor.voice_gender)


@api.post("/tts")
def tts_post(body: TTSIn, actor: Actor = Depends(get_actor)):
    return _speech(body.text, body.language, body.rate, body.gender or actor.voice_gender)


# ---------- Routers ----------

api.include_router(routes_auth.router)
api.include_router(routes_learning.router)  # personal words and corrections
if settings.learning_enabled:
    api.include_router(routes_learning.course_router)
if settings.accounts_enabled:
    api.include_router(routes_billing.router)
    api.include_router(routes_connect.router)
app.include_router(api)
if settings.accounts_enabled:
    app.include_router(routes_billing.public)
    app.include_router(routes_admin.router)  # dashboard: its own email + password sign-in, no API key


def _mount_dashboard() -> None:
    """Serves the built admin dashboard (apps/admin/dist) at /dashboard when the folder exists."""
    import os

    from fastapi.staticfiles import StaticFiles

    folder = os.path.abspath(settings.dashboard_dir)
    if settings.accounts_enabled and os.path.isfile(os.path.join(folder, "index.html")):
        app.mount("/dashboard", StaticFiles(directory=folder, html=True), name="dashboard")


_mount_dashboard()


@app.on_event("startup")
def _startup() -> None:
    if settings.app_env == "production":
        # Refuse to start with development shortcuts switched on.
        if settings.accounts_enabled and settings.sms_provider == "console":
            raise RuntimeError("APP_ENV=production needs a real SMS provider (BOLVERSE_SMS_PROVIDER), not console.")
        if not (settings.data_key or settings.secret_key):
            raise RuntimeError("APP_ENV=production needs BOLVERSE_DATA_KEY and BOLVERSE_SECRET_KEY.")
    log.info("Starting in %s mode%s", settings.app_env,
             " (test accounts with code 123456 enabled)" if settings.dev_mode and settings.seed_test_users else "")
    init_db()
    if settings.accounts_enabled and settings.seed_test_users and settings.dev_mode:
        from .seed import seed

        made = seed()
        if made:
            log.info("Created dummy data (code 123456): %s", ", ".join(made))
    if settings.accounts_enabled:
        routes_admin.ensure_first_owner()
    if settings.preload and not ai.remote:
        threading.Thread(target=ai.preload, daemon=True).start()
