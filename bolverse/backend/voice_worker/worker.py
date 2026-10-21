"""Bolverse voice worker: natural male and female voices.

- AI4Bharat Indic Parler-TTS for Indian languages (Hindi, Bengali, Tamil, Telugu and 9 more).
- Kokoro for English, Spanish, French, Italian, Portuguese, Japanese and Mandarin.

Runs beside the main server in its own Python 3.12 environment:
    uvicorn voice_worker.worker:app --host 127.0.0.1 --port 8001      (from the backend folder)
The main server calls it at BOLVERSE_VOICE_WORKER_URL and falls back to its built-in voices if it's down.
"""
from __future__ import annotations

import importlib.util
import io
import logging
import re
import sys
import threading
import wave
from pathlib import Path
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.languages import Language, find  # noqa: E402  (plain data module, no server dependencies)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s voice-worker %(message)s")
log = logging.getLogger("voice-worker")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
HAS_KOKORO = importlib.util.find_spec("kokoro") is not None
HAS_PARLER = importlib.util.find_spec("parler_tts") is not None
_lock = threading.Lock()
_kokoro: dict[str, object] = {}
_parler: tuple | None = None
_SENTENCES = re.compile(r"(?<=[.!?।॥。！？])\s+")

app = FastAPI(title="Bolverse voice worker")


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    language: str
    gender: Literal["male", "female"] = "female"
    rate: float = Field(1.0, ge=0.5, le=2.0)


def _wav(samples: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _kokoro_speak(lang: Language, text: str, gender: str, rate: float) -> tuple[np.ndarray, int, str]:
    from kokoro import KPipeline

    code, female, male = lang.kokoro
    voice = (male if gender == "male" else female) or female or male
    if code not in _kokoro:
        _kokoro[code] = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", device=DEVICE)
    parts = []
    for _, _, audio in _kokoro[code](text, voice=voice, speed=rate):
        parts.append(audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio))
    return np.concatenate(parts).astype(np.float32), 24_000, "male" if voice == male else "female"


def _parler_speak(lang: Language, text: str, gender: str, rate: float) -> tuple[np.ndarray, int, str]:
    global _parler
    if _parler is None:
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        name = "ai4bharat/indic-parler-tts"
        dtype = torch.bfloat16 if DEVICE == "cuda" else torch.float32  # as recommended by the model card
        model = ParlerTTSForConditionalGeneration.from_pretrained(name, torch_dtype=dtype).to(DEVICE).eval()
        _parler = (model, AutoTokenizer.from_pretrained(name),
                   AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path))
    model, tok, desc_tok = _parler
    pace = "slowly and clearly" if rate < 0.9 else "quickly" if rate > 1.15 else "at a moderate pace"
    description = (f"A {gender} speaker speaks {pace} with a clear, warm and expressive voice. "
                   "The recording is very clear and close-sounding, with no background noise.")
    d = desc_tok(description, return_tensors="pt").to(DEVICE)
    sr = model.config.sampling_rate
    gap = np.zeros(int(sr * 0.2), dtype=np.float32)
    parts: list[np.ndarray] = []
    for sentence in [s for s in _SENTENCES.split(text.strip()) if s.strip()][:12]:
        p = tok(sentence, return_tensors="pt").to(DEVICE)
        with torch.inference_mode():
            out = model.generate(input_ids=d.input_ids, attention_mask=d.attention_mask,
                                 prompt_input_ids=p.input_ids, prompt_attention_mask=p.attention_mask)
        parts += [out.to(torch.float32).cpu().numpy().squeeze(), gap]
    return np.concatenate(parts), sr, gender


def _engines(lang: Language):
    if lang.parler and HAS_PARLER:
        yield _parler_speak
    if lang.kokoro and HAS_KOKORO:
        yield _kokoro_speak


def genders(lang: Language) -> list[str]:
    out: set[str] = set()
    if lang.parler and HAS_PARLER:
        out |= {"female", "male"}
    if lang.kokoro and HAS_KOKORO:
        out |= {g for g, v in (("female", lang.kokoro[1]), ("male", lang.kokoro[2])) if v}
    return sorted(out)


@app.get("/health")
def health():
    return {"status": "ok", "device": DEVICE, "kokoro": HAS_KOKORO, "parler": HAS_PARLER,
            "loaded": {"parler": _parler is not None, "kokoro": sorted(_kokoro)}}


@app.get("/voices/{code}")
def voices(code: str):
    lang = find(code)
    return {"language": code, "genders": genders(lang) if lang else []}


@app.post("/speak")
def speak(body: SpeakIn):
    lang = find(body.language)
    if lang is None:
        raise HTTPException(404, "Unknown language.")
    for engine in _engines(lang):
        try:
            with _lock:
                audio, sr, used = engine(lang, body.text, body.gender, body.rate)
            return Response(_wav(audio, sr), media_type="audio/wav",
                            headers={"X-Voice-Gender": used, "X-Voice-Engine": engine.__name__.strip("_").split("_")[0]})
        except Exception:
            log.exception("%s failed for %s", engine.__name__, lang.code)
    raise HTTPException(404, "No voice for this language here.")
