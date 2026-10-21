"""Bolverse AI worker: speech, translation, reading guides and voices, with no accounts or database.

Runs where the GPU is. The main server calls it when BOLVERSE_AI_URL points here.
    PORT=80 python -m app.ai_server        (RunPod load-balancing endpoints use port 80 and poll GET /ping)

GET /ping answers 204 while models load and 200 when ready, which is what RunPod's load balancer expects.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .ai import LocalAI
from .audio import AudioError
from .config import settings
from .languages import Language, find

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s ai-worker %(message)s")
log = logging.getLogger("bolverse")
engine = LocalAI()
READY = threading.Event()
app = FastAPI(title="Bolverse AI worker")


@app.exception_handler(AudioError)
async def _audio_error(_: Request, exc: AudioError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


def check_secret(x_ai_secret: str | None = Header(default=None)) -> None:
    if settings.ai_secret and x_ai_secret != settings.ai_secret:
        raise HTTPException(401, "Wrong AI secret.")


def lang(code: str) -> Language:
    found = find(code)
    if not found:
        raise HTTPException(400, f"Unsupported language: {code}")
    return found


@app.on_event("startup")
def _load() -> None:
    def run():
        engine.preload()
        READY.set()
        log.info("All models loaded; ready.")
    threading.Thread(target=run, daemon=True).start()


@app.get("/ping")
def ping():
    return Response(status_code=200 if READY.is_set() else 204)


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    source: str = ""
    target: str = ""
    language: str = ""


class PolishIn(BaseModel):
    source_text: str
    translation: str
    source: str
    target: str
    speaker_gender: str | None = None
    reader: str | None = None
    readings: bool = False


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    language: str
    rate: float = Field(1.0, ge=0.5, le=2.0)
    gender: Literal["male", "female"] | None = None


secured = [Depends(check_secret)]


@app.post("/ai/transcribe", dependencies=secured)
def transcribe(audio: UploadFile = File(...), language: str = Form(...), hints: str = Form("[]")):
    return engine.transcribe(audio.file.read(), audio.filename, lang(language), json.loads(hints or "[]"))


@app.post("/ai/translate", dependencies=secured)
def translate(body: TextIn):
    return {"text": engine.translate(body.text, lang(body.source), lang(body.target))}


@app.post("/ai/native", dependencies=secured)
def native(body: TextIn):
    return {"text": engine.to_native(body.text, lang(body.language))}


@app.post("/ai/polish", dependencies=secured)
def polish(body: PolishIn):
    return engine.polish(body.source_text, body.translation, lang(body.source), lang(body.target),
                         body.speaker_gender, find(body.reader) if body.reader else None, body.readings)


@app.post("/ai/speak", dependencies=secured)
def speak(body: SpeakIn):
    spoken = engine.speak(body.text, lang(body.language), body.rate, body.gender)
    if spoken is None:
        raise HTTPException(404, "No server voice for this language.")
    wav, used = spoken
    return Response(content=wav, media_type="audio/wav", headers={"X-Voice-Gender": used})


@app.get("/ai/voices/{code}", dependencies=secured)
def voices(code: str):
    return engine.voice_options(lang(code))


@app.get("/ai/status", dependencies=secured)
def status():
    return {**engine.status(), "ready": READY.is_set()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "80")))
