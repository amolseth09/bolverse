"""Speech to text. Everything runs on this server; nothing is sent to an outside service.

- Whisper large-v3-turbo through faster-whisper (CTranslate2): about 4x faster than the plain
  transformers pipeline on a T4, uses less GPU memory, and has Silero voice detection built in, so
  pauses and background noise are skipped instead of being "heard" as words. Beam search (5) and the
  user's own words as hotwords make it noticeably more accurate on short phone recordings.
- If faster-whisper can't load (missing CUDA libraries, old GPU), the transformers pipeline is used.
- Indian languages can go to AI4Bharat IndicConformer when it's switched on (BOLVERSE_INDIC_ASR).
- Known Whisper "hallucinations" on silence ("Thank you.", "Subscribe…") are thrown away.
"""
from __future__ import annotations

import glob
import logging
import os
import re
import threading

import numpy as np

from ..audio import ASR_SAMPLE_RATE, AudioError
from ..config import settings
from ..languages import Language
from ..runtime import DEVICE, DTYPE, Lazy
from .vocab import apply_vocabulary

log = logging.getLogger("bolverse")

# faster-whisper names for the same weights as the transformers model ids.
_FAST_NAMES = {
    "openai/whisper-large-v3-turbo": "large-v3-turbo",
    "openai/whisper-large-v3": "large-v3",
    "openai/whisper-medium": "medium",
    "openai/whisper-small": "small",
}

# Phrases Whisper invents from silence or noise (from its YouTube-subtitle training data).
_HALLUCINATIONS = re.compile(
    r"^(thanks for watching!?|thank you for watching\.?|please subscribe.*|like and subscribe.*|"
    r"subtitles by.*|♪+|[.…]+|amara\.org.*|ご視聴ありがとうございました.*|"
    r"продолжение следует.*|untertitel.*|sous-titres.*)$",
    re.IGNORECASE,
)


def _preload_cuda_libs() -> None:
    """Colab ships cuDNN/cuBLAS as pip packages that CTranslate2 can't find on its own; load them by path."""
    if DEVICE != "cuda":
        return
    import ctypes
    import site

    roots = site.getsitepackages() + [site.getusersitepackages()]
    for pattern in ("nvidia/cublas/lib/libcublas*.so*", "nvidia/cudnn/lib/libcudnn*.so*"):
        for root in roots:
            for path in sorted(glob.glob(os.path.join(root, pattern))):
                try:
                    ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


def _load_fast():
    from faster_whisper import WhisperModel

    _preload_cuda_libs()
    name = settings.fast_asr_model or _FAST_NAMES.get(settings.asr_model, settings.asr_model)
    compute = "float16" if DEVICE == "cuda" else "int8"
    model = WhisperModel(name, device="cuda" if DEVICE == "cuda" else "cpu", compute_type=compute)
    # Run once on silence so a broken CUDA setup fails here (and falls back) instead of on a user's request.
    list(model.transcribe(np.zeros(ASR_SAMPLE_RATE, dtype=np.float32), language="en", beam_size=1)[0])
    return model


def _load_pipeline():
    from transformers import pipeline

    return pipeline("automatic-speech-recognition", model=settings.asr_model, device=DEVICE,
                    torch_dtype=DTYPE, chunk_length_s=30)


def _load_indic():
    from transformers import AutoModel

    model = AutoModel.from_pretrained(settings.indic_asr_model, trust_remote_code=True)
    try:
        model = model.to(DEVICE)
    except Exception:  # some remote-code models manage their own device
        pass
    return model


FAST = Lazy("speech-to-text (faster-whisper)", _load_fast)
ASR = Lazy("speech-to-text (transformers)", _load_pipeline)
INDIC = Lazy("indian speech-to-text", _load_indic)
_state = {"fast_broken": settings.asr_engine == "transformers", "indic_broken": False}
_state_lock = threading.Lock()


def engine_name() -> str:
    return "transformers" if _state["fast_broken"] else "faster-whisper"


def load() -> None:
    """Load the speech model up front (used by preload). Falls back to transformers if needed."""
    _get_fast()
    if _state["fast_broken"]:
        ASR.get()


def _get_fast():
    if _state["fast_broken"]:
        return None
    try:
        return FAST.get()
    except Exception:
        log.exception("faster-whisper couldn't load; using the transformers Whisper pipeline instead")
        with _state_lock:
            _state["fast_broken"] = True
        return None


def _indic(samples: np.ndarray, lang: Language) -> str | None:
    if not (settings.indic_asr and lang.indic) or _state["indic_broken"]:
        return None
    try:
        import torch

        model = INDIC.get()
        wav = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
        with INDIC.run_lock, torch.inference_mode():
            text = model(wav, lang.indic, "rnnt")
        return str(text[0] if isinstance(text, (list, tuple)) else text).strip()
    except Exception:
        log.exception("IndicConformer failed; using Whisper for Indian languages from now on")
        _state["indic_broken"] = True
        return None


def _prompt(hints: list[str]) -> str:
    return ", ".join(h for h in hints if h)[:200]


def _fast(model, samples: np.ndarray, lang: Language, hints: list[str]) -> str:
    prompt = _prompt(hints)
    with FAST.run_lock:
        segments, info = model.transcribe(
            samples, language=lang.whisper, task="transcribe",
            beam_size=settings.asr_beam, best_of=settings.asr_beam,
            temperature=[0.0, 0.2, 0.4],          # retry warmer only when the first pass looks wrong
            condition_on_previous_text=False,    # short clips: don't let one mistake carry on
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 600, "speech_pad_ms": 300, "threshold": 0.35},
            no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
            without_timestamps=True,
            hotwords=prompt or None,
        )
        parts = [s.text.strip() for s in segments if not (s.no_speech_prob > 0.7 and s.avg_logprob < -0.8)]
    if (info.duration_after_vad or 0) < 0.25:  # the voice detector found (almost) no speech
        return ""
    return " ".join(p for p in parts if p).strip()


def _pipeline(samples: np.ndarray, lang: Language, hints: list[str]) -> str:
    asr = ASR.get()
    kwargs: dict = {"language": lang.whisper, "task": "transcribe", "num_beams": settings.asr_beam}
    prompt = _prompt(hints)
    if prompt:
        kwargs["prompt_ids"] = asr.tokenizer.get_prompt_ids(prompt, return_tensors="pt").to(DEVICE)
    with ASR.run_lock:
        out = asr({"raw": samples, "sampling_rate": ASR_SAMPLE_RATE}, generate_kwargs=kwargs)
    text = str(out.get("text", "")).strip()
    if prompt and text.startswith(prompt):  # some versions echo the prompt back
        text = text[len(prompt):].lstrip(" ,.")
    return text


def _whisper(samples: np.ndarray, lang: Language, hints: list[str]) -> str:
    if not lang.whisper:
        raise AudioError(f"Speech input for {lang.name} isn't available on this server yet. Type instead.")
    model = _get_fast()
    if model is not None:
        try:
            return _fast(model, samples, lang, hints)
        except Exception:
            log.exception("faster-whisper failed on a request; switching to the transformers pipeline")
            with _state_lock:
                _state["fast_broken"] = True
    return _pipeline(samples, lang, hints)


def clean_text(text: str) -> str:
    """Drop Whisper's silence hallucinations and repeated phrases."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text or _HALLUCINATIONS.match(text):
        return ""
    # "where is the station where is the station where is the station" -> once
    words = text.split()
    for size in range(1, min(8, len(words) // 3) + 1):
        unit = words[:size]
        if len(words) % size == 0 and words == unit * (len(words) // size) and len(words) // size >= 3:
            return " ".join(unit)
    return text


def transcribe(samples: np.ndarray, lang: Language, hints: list[str] | None = None) -> str:
    hints = hints or []
    text = _indic(samples, lang)
    if text is None:
        text = _whisper(samples, lang, hints)
    return apply_vocabulary(clean_text(text), hints)
