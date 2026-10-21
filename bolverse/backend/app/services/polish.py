"""Second pass after machine translation, using the LLM:

1. Speaker gender: in Hindi, Spanish, French, Arabic and similar languages, what "I" says depends on
   who is speaking (मैं थका हूँ / मैं थकी हूँ, cansado / cansada). NLLB can't know the speaker, so words
   referring to the speaker are corrected here and nothing else is changed.
2. Reading guides: the translation written the way it sounds, in the user's own script and in English letters.
"""
from __future__ import annotations

from functools import lru_cache

from ..languages import Language, find
from .llm import chat_json
from .scoring import similarity
from .textutil import romanize

# Languages where words about the speaker ("I am tired", "I went") change with the speaker's gender.
GENDERED_FIRST_PERSON = {
    "hi-IN", "ur-IN", "mr-IN", "gu-IN", "pa-IN", "ne-NP",
    "es-ES", "fr-FR", "it-IT", "pt-PT", "pt-BR", "ro-RO", "el-GR", "is-IS",
    "ru-RU", "uk-UA", "pl-PL", "cs-CZ", "hr-HR", "sr-RS", "bg-BG",
    "ar-SA", "he-IL",
}


def _script(lang: Language) -> str:
    return lang.nllb.split("_")[1]


@lru_cache(maxsize=4096)
def _polish(source_text: str, translation: str, src_code: str, tgt_code: str, gender: str,
            reader_code: str, want_gender: bool, want_native: bool, want_english: bool) -> tuple[str, str, str]:
    src, tgt, reader = find(src_code), find(tgt_code), find(reader_code) if reader_code else None
    fields, rules = [], []
    if want_gender:
        fields.append('"translation": "..."')
        rules.append(
            f'"translation": the {tgt.name} translation below, unchanged except that any word referring to the speaker '
            f'(I, me, my, myself) must agree with a {gender} speaker. If nothing refers to the speaker, return it exactly as given.')
    if want_native:
        fields.append('"native_reading": "..."')
        rules.append(
            f'"native_reading": how the {tgt.name} sentence sounds, written in {reader.name} script ({reader.native}) so a '
            f'{reader.name} speaker can read it aloud. Transliterate the sounds; do not translate.')
    if want_english:
        fields.append('"english_reading": "..."')
        rules.append(
            f'"english_reading": how the {tgt.name} sentence sounds, written in simple English letters an English speaker '
            'can read aloud, with hyphens between syllables of longer words. Do not translate.')
    data = chat_json(
        [{"role": "system", "content": "You are a precise interpreter's assistant. Reply with valid JSON only."},
         {"role": "user", "content": (
             f"Original ({src.name}): {source_text}\n{tgt.name} translation: {translation}\n\n"
             "Return JSON {" + ", ".join(fields) + "} where:\n- " + "\n- ".join(rules))}],
        max_new_tokens=260, temperature=0,
    )
    fixed = str(data.get("translation") or translation).strip() if want_gender else translation
    # Guard: a gender fix changes a few letters, never the whole sentence.
    if similarity(fixed, translation) < 0.6:
        fixed = translation
    return fixed, str(data.get("native_reading") or "").strip(), str(data.get("english_reading") or "").strip()


def polish(source_text: str, translation: str, src: Language, tgt: Language, speaker_gender: str | None,
           reader: Language | None = None, readings: bool = False) -> dict:
    want_gender = speaker_gender in ("male", "female") and tgt.code in GENDERED_FIRST_PERSON
    want_native = bool(readings and reader and not reader.latin and _script(reader) != _script(tgt))
    want_english = bool(readings and not tgt.code.startswith("en-"))
    fallback = {"translation": translation, "native_reading": "",
                "english_reading": romanize(translation, tgt) if readings else ""}
    if not (want_gender or want_native or want_english) or not translation:
        return fallback
    try:
        fixed, native, english = _polish(source_text, translation, src.code, tgt.code, speaker_gender or "",
                                         reader.code if reader else "", want_gender, want_native, want_english)
    except Exception:
        return fallback
    return {"translation": fixed, "native_reading": native if want_native else "",
            "english_reading": english or fallback["english_reading"] if want_english else ""}
