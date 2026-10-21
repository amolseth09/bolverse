"""The AI engine behind a small interface, running either here or on a separate AI worker.

- Local (BOLVERSE_AI_URL empty): models load in this process. Used on Colab and on a single GPU machine.
- Remote (BOLVERSE_AI_URL set): this server keeps accounts, limits and billing, and sends AI work to
  app.ai_server running on a GPU elsewhere, e.g. a RunPod serverless endpoint that scales to zero.
"""
from __future__ import annotations

import json
import logging
import threading

import httpx

from .audio import AudioError
from .config import settings
from .languages import Language, find

log = logging.getLogger("bolverse")


class AIUnavailable(RuntimeError):
    pass


class LocalAI:
    remote = False

    def transcribe(self, audio: bytes, filename: str | None, lang: Language, hints: list[str]) -> dict:
        from .audio import decode, estimate_gender
        from .services import speech

        samples = decode(audio, filename)
        return {"text": speech.transcribe(samples, lang, hints), "speaker_gender": estimate_gender(samples)}

    def translate(self, text: str, src: Language, tgt: Language) -> str:
        from .services import translate as tr

        return tr.translate(text, src, tgt)

    def to_native(self, text: str, lang: Language) -> str:
        from .services import translate as tr

        return tr.to_native_script(text, lang)

    def polish(self, source_text: str, translation: str, src: Language, tgt: Language,
               speaker_gender: str | None, reader: Language | None, readings: bool) -> dict:
        from .services.polish import polish

        return polish(source_text, translation, src, tgt, speaker_gender, reader, readings)

    def speak(self, text: str, lang: Language, rate: float, gender: str | None) -> tuple[bytes, str] | None:
        from .services import tts

        return tts.synthesize(text, lang, rate, gender)

    def voice_options(self, lang: Language) -> dict:
        from .services import tts

        return tts.voice_options(lang)

    def status(self) -> dict:
        from .services import speech, translate as tr
        from .services.llm import LLM

        loaded = {"speech_to_text": speech.FAST.loaded or speech.ASR.loaded, "translation": tr.NLLB.loaded,
                  "language_model": LLM.loaded}
        if settings.indic_asr and not speech._state["indic_broken"]:
            loaded["indian_speech"] = speech.INDIC.loaded
        from .runtime import DEVICE

        return {"mode": "local", "device": DEVICE, "speech_engine": speech.engine_name(), "loaded": loaded}

    def preload(self) -> None:
        from .services import speech, translate as tr
        from .services.llm import LLM

        try:
            speech.load()
        except Exception:
            log.exception("Preloading speech-to-text failed")
        for model in (tr.NLLB if settings.translation_backend == "nllb" else None, LLM):
            if model is not None:
                try:
                    model.get()
                except Exception:
                    log.exception("Preloading %s failed", model.name)
        if settings.indic_asr:
            try:
                speech.INDIC.get()
            except Exception:
                log.exception("Indian speech model failed to load; Whisper will handle Indian languages")
                speech._state["indic_broken"] = True


class RemoteAI:
    """Calls app.ai_server. Cold starts on serverless GPUs can take a while, hence the long timeout."""
    remote = True

    def __init__(self, url: str):
        self.url = url
        headers = {"X-AI-Secret": settings.ai_secret}
        if settings.ai_auth:
            headers["Authorization"] = f"Bearer {settings.ai_auth}"
        self.client = httpx.Client(base_url=url, headers=headers, timeout=httpx.Timeout(180, connect=15))

    def _post(self, path: str, **kwargs) -> httpx.Response:
        try:
            r = self.client.post(path, **kwargs)
        except httpx.HTTPError as exc:
            log.warning("AI worker unreachable: %s", exc)
            raise AIUnavailable("Bolverse's AI is waking up. Try again in a few seconds.") from exc
        if r.status_code == 422:
            raise AudioError(r.json().get("detail", "The recording couldn't be read."))
        if r.status_code >= 500 or r.status_code in (401, 403):
            log.warning("AI worker error %s: %s", r.status_code, r.text[:200])
            raise AIUnavailable("Bolverse's AI had a problem. Try again in a moment.")
        return r

    def transcribe(self, audio, filename, lang, hints):
        return self._post("/ai/transcribe", files={"audio": (filename or "speech.webm", audio)},
                          data={"language": lang.code, "hints": json.dumps(hints)}).json()

    def translate(self, text, src, tgt):
        return self._post("/ai/translate", json={"text": text, "source": src.code, "target": tgt.code}).json()["text"]

    def to_native(self, text, lang):
        return self._post("/ai/native", json={"text": text, "language": lang.code}).json()["text"]

    def polish(self, source_text, translation, src, tgt, speaker_gender, reader, readings):
        return self._post("/ai/polish", json={
            "source_text": source_text, "translation": translation, "source": src.code, "target": tgt.code,
            "speaker_gender": speaker_gender, "reader": reader.code if reader else None, "readings": readings}).json()

    def speak(self, text, lang, rate, gender):
        r = self._post("/ai/speak", json={"text": text, "language": lang.code, "rate": rate, "gender": gender})
        return (r.content, r.headers.get("x-voice-gender", "any")) if r.status_code == 200 else None

    def voice_options(self, lang):
        try:
            return self.client.get(f"/ai/voices/{lang.code}", timeout=20).json()
        except (httpx.HTTPError, ValueError):
            return {"available": False, "genders": []}

    def status(self):
        try:
            data = self.client.get("/ai/status", timeout=10).json()
            return {**data, "mode": "remote", "reachable": True}
        except (httpx.HTTPError, ValueError):
            return {"mode": "remote", "reachable": False}

    def preload(self):
        pass


_engine = None
_lock = threading.Lock()


class DemoAI:
    """BOLVERSE_AI_DEMO=true: no models at all. Answers instantly with placeholder translations, so logins,
    payments, Connect chats and the dashboard can be tried on any laptop without a GPU or Colab."""
    remote = False

    def transcribe(self, audio: bytes, filename: str | None, lang: Language, hints: list[str]) -> dict:
        return {"text": lang.hello + " (demo voice message)", "speaker_gender": None}

    def translate(self, text: str, src: Language, tgt: Language) -> str:
        return f"[{tgt.name}] {text}"

    def to_native(self, text: str, lang: Language) -> str:
        return text

    def polish(self, source_text, translation, src, tgt, speaker_gender, reader, readings) -> dict:
        return {"translation": translation, "native_reading": f"(how to say it, demo)" if readings else "",
                "english_reading": "(in English letters, demo)" if readings else ""}

    def speak(self, text, lang, rate, gender):
        return None  # devices use their own voice

    def voice_options(self, lang: Language) -> dict:
        return {"available": False, "genders": []}

    def status(self) -> dict:
        return {"mode": "demo", "device": "none", "loaded": {"demo": True}}

    def preload(self) -> None:
        pass


def get_ai():
    global _engine
    with _lock:
        if _engine is None:
            if settings.ai_demo:
                _engine = DemoAI()
            else:
                _engine = RemoteAI(settings.ai_url) if settings.ai_url else LocalAI()
        return _engine


def lang_or_none(code: str | None) -> Language | None:
    return find(code) if code else None
