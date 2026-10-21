"""Speech output.

1. Male and female voices come from the voice worker (Indic Parler-TTS, Kokoro) when it's running.
2. Otherwise Meta MMS-TTS: one voice per language. When the user chose the other gender, its pitch is
   moved to a typical male or female pitch (audio.shift_to_gender), so the choice is always honoured.
3. Otherwise nothing, and the apps use the phone's or browser's own voice, choosing its gender.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict

import httpx
import numpy as np
import torch
from transformers import AutoTokenizer, VitsModel

from ..audio import shift_to_gender, to_wav
from ..config import settings
from ..languages import Language, gender_voices
from ..runtime import DEVICE

log = logging.getLogger("bolverse")
_cache: "OrderedDict[str, tuple]" = OrderedDict()
_unavailable: set[str] = set()
_lock = threading.Lock()
_uroman = None
_worker_genders: dict[str, tuple[float, list[str]]] = {}
WORKER_RECHECK_SECONDS = 60


# ---------- Voice worker ----------

def worker_genders(lang: Language) -> list[str]:
    """Genders the voice worker can speak for this language (cached; [] when it's down)."""
    if not settings.voice_worker_url or not gender_voices(lang):
        return []
    cached = _worker_genders.get(lang.code)
    if cached and time.time() - cached[0] < WORKER_RECHECK_SECONDS:
        return cached[1]
    try:
        r = httpx.get(f"{settings.voice_worker_url}/voices/{lang.code}", timeout=3)
        genders = list(r.json().get("genders", [])) if r.status_code == 200 else []
    except httpx.HTTPError:
        genders = []
    _worker_genders[lang.code] = (time.time(), genders)
    return genders


def _worker_speak(text: str, lang: Language, rate: float, gender: str) -> tuple[bytes, str] | None:
    if not worker_genders(lang):  # worker down, or no voices for this language
        return None
    try:
        r = httpx.post(f"{settings.voice_worker_url}/speak",
                       json={"text": text, "language": lang.code, "gender": gender, "rate": rate}, timeout=90)
        if r.status_code == 200:
            return r.content, r.headers.get("x-voice-gender", gender)
    except httpx.HTTPError as exc:
        log.warning("Voice worker unavailable: %s", exc)
        _worker_genders.pop(lang.code, None)
    return None


# ---------- MMS (single neutral voice) ----------

def _romanizer():
    global _uroman
    if _uroman is None:
        import uroman

        _uroman = uroman.Uroman()
    return _uroman


def _mms(mms: str):
    with _lock:
        if mms in _unavailable:
            return None
        if mms in _cache:
            _cache.move_to_end(mms)
            return _cache[mms]
    name = f"facebook/mms-tts-{mms}"
    try:
        tok = AutoTokenizer.from_pretrained(name)
        model = VitsModel.from_pretrained(name).to(DEVICE).eval()
    except Exception as exc:
        log.warning("No MMS voice for %s: %s", mms, exc)
        with _lock:
            _unavailable.add(mms)
        return None
    with _lock:
        _cache[mms] = (tok, model, threading.Lock())
        while len(_cache) > max(1, settings.tts_cache_size):
            _cache.popitem(last=False)
        return _cache[mms]


def _mms_speak(text: str, lang: Language, rate: float, gender: str | None = None) -> tuple[bytes, str] | None:
    entry = _mms(lang.mms) if lang.mms else None
    if entry is None:
        return None
    tok, model, run_lock = entry
    if getattr(tok, "is_uroman", False):
        text = _romanizer().romanize_string(text)
    pieces: list[np.ndarray] = []
    sr = model.config.sampling_rate
    silence = np.zeros(int(sr * 0.25), dtype=np.float32)
    for sentence in [s for s in text.replace("\n", " ").split(". ") if s.strip()][:20]:
        inputs = tok(sentence, return_tensors="pt").to(DEVICE)
        if inputs["input_ids"].shape[1] == 0:
            continue
        with run_lock, torch.inference_mode():
            model.speaking_rate = float(rate)
            wave = model(**inputs).waveform[0].float().cpu().numpy()
        pieces += [wave, silence]
    if not pieces:
        return None
    audio = np.concatenate(pieces)
    used = "any"
    if gender in ("male", "female"):
        audio, _changed = shift_to_gender(audio, sr, gender)
        used = gender
    return to_wav(audio, sr), used


# ---------- Public API ----------

def voice_options(lang: Language) -> dict:
    """What the server can speak: {"available": bool, "genders": ["female", "male"] or ["any"] or []}."""
    if not settings.tts_enabled:
        return {"available": False, "genders": []}
    genders = worker_genders(lang)
    if genders:
        return {"available": True, "genders": genders}
    if lang.mms and _mms(lang.mms) is not None:
        # One voice, shifted to the requested gender when needed: both can be asked for.
        return {"available": True, "genders": ["female", "male"], "natural": False}
    return {"available": False, "genders": []}


def has_voice(lang: Language) -> bool:
    return voice_options(lang)["available"]


def synthesize(text: str, lang: Language, rate: float = 1.0, gender: str | None = None) -> tuple[bytes, str] | None:
    """Returns (wav, voice gender: "male" | "female" | "any"), or None when the server has no voice."""
    if not settings.tts_enabled:
        return None
    if gender in ("male", "female") or worker_genders(lang):
        spoken = _worker_speak(text, lang, rate, gender or "female")
        if spoken:
            return spoken
    return _mms_speak(text, lang, rate, gender)
