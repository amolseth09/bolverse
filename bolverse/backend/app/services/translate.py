"""Translation with NLLB-200 (default) or the LLM, plus a Latin-letter reading aid."""
from __future__ import annotations

import re
from functools import lru_cache

import torch
from anyascii import anyascii
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

from ..config import settings
from ..languages import Language
from ..runtime import DEVICE, DTYPE, Lazy
from .llm import chat_json
from .textutil import is_romanized, romanize  # noqa: F401  (re-exported)


def _load():
    tok = AutoTokenizer.from_pretrained(settings.nllb_model)
    model = AutoModelForSeq2SeqLM.from_pretrained(settings.nllb_model, torch_dtype=DTYPE, low_cpu_mem_usage=True).to(DEVICE).eval()
    return tok, model


NLLB = Lazy("translation", _load)
_SENTENCE_END = re.compile(r"(?<=[.!?।॥。！？؟])\s+")


def _split(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_END.split(text.strip())]
    return [p for p in parts if p] or [text.strip()]


def _nllb(text: str, src: Language, tgt: Language) -> str:
    tok, model = NLLB.get()
    sentences = _split(text)
    with NLLB.run_lock, torch.inference_mode():
        tok.src_lang = src.nllb
        batch = tok(sentences, return_tensors="pt", padding=True, truncation=True, max_length=400).to(DEVICE)
        out = model.generate(
            **batch,
            forced_bos_token_id=tok.convert_tokens_to_ids(tgt.nllb),
            max_new_tokens=int(batch["input_ids"].shape[1] * 2 + 16),
            num_beams=4,
        )
    return " ".join(s.strip() for s in tok.batch_decode(out, skip_special_tokens=True))


def _llm(text: str, src: Language, tgt: Language) -> str:
    data = chat_json(
        [
            {"role": "system", "content": "You are a professional live interpreter. You translate faithfully and naturally."},
            {"role": "user", "content": (
                f"Translate this spoken sentence from {src.name} into {tgt.name}. Keep the tone and politeness, "
                f"fix obvious speech-recognition slips, write {tgt.name} in its native script.\n"
                'Reply with only JSON: {"translation": "..."}\n\n'
                f"Sentence: {text}"
            )},
        ],
        max_new_tokens=400,
        temperature=0,
    )
    return str(data.get("translation", "")).strip()


def translate(text: str, src: Language, tgt: Language) -> str:
    if src.code == tgt.code:
        return text
    if settings.translation_backend == "llm":
        return _llm(text, src, tgt)
    return _nllb(text, src, tgt)


# ---------- Hinglish and other languages typed in English letters ----------

@lru_cache(maxsize=4096)
def _to_native(text: str, lang_code: str) -> str:
    from ..languages import find

    lang = find(lang_code)
    data = chat_json(
        [
            {"role": "system", "content": "You convert chat-style romanized text into its proper native script. You never translate."},
            {"role": "user", "content": (
                f"This is {lang.name} typed in English letters, the way people type on phones. It may mix in English "
                f"words that {lang.name} speakers use. Rewrite it in {lang.name} script ({lang.native}) exactly as spoken. "
                f"Write English loanwords the way {lang.name} speakers write them. Do not translate or add anything.\n"
                'Reply with only JSON: {"text": "..."}\n\n'
                f"Text: {text}"
            )},
        ],
        max_new_tokens=300,
        temperature=0,
    )
    return str(data.get("text", "")).strip() or text


def to_native_script(text: str, lang: Language) -> str:
    """Hinglish -> Devanagari (and the same for other scripts). Returns the text unchanged if not romanized."""
    if not is_romanized(text, lang):
        return text
    try:
        return _to_native(text.strip(), lang.code)
    except Exception:
        return text

