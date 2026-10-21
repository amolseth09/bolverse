"""Structured spoken lessons and free-form tutor answers."""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import settings
from ..languages import Language
from ..schemas import Lesson
from ..units import UNITS
from .llm import chat, chat_json

TUTOR_SYSTEM = (
    "You are a warm, clear spoken language tutor. Your words are read aloud by text-to-speech, "
    "so you write short, natural spoken sentences with no markdown, symbols or bullet characters."
)


def _cache_path(base: Language, target: Language, unit: int) -> Path:
    folder = Path(settings.data_dir) / "lessons"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{base.code}__{target.code}__{unit}.json"


def lesson(base: Language, target: Language, unit: int, refresh: bool = False) -> Lesson:
    path = _cache_path(base, target, unit)
    if path.exists() and not refresh:
        return Lesson.model_validate_json(path.read_text(encoding="utf-8"))

    u = UNITS[unit]
    earlier = "; ".join(x["title"] for x in UNITS[:unit]) or "none"
    romanized_rule = (
        f'"romanized" must be "" because {target.name} uses the Latin alphabet.'
        if target.latin
        else f'"romanized" is a simple Latin-letter pronunciation guide for the {target.name} text.'
    )
    prompt = f"""Learner's base language: {base.name}. Language being learned: {target.name}.
This is unit {unit + 1} of {len(UNITS)} in a structured course. Unit: "{u['title']}". Focus: {u['focus']}. Earlier units: {earlier}.
Teach the grammar pattern itself as it really works in {target.name} (word order, verb forms, gender, particles, politeness and so on), comparing with {base.name} where it helps.
Write every explanation in {base.name} using its native script. Write every example in {target.name} using its native script.
Reply with only JSON in exactly this shape:
{{"title":"lesson title in {base.name}","intro":"2 to 3 spoken sentences","points":[{{"rule":"explanation, under 60 words","examples":[{{"target":"{target.name} sentence","romanized":"...","meaning":"meaning in {base.name}"}}]}}],"practice":[{{"prompt":"in {base.name}: ask the learner to say something","answer":"the {target.name} sentence","romanized":"..."}}],"recap":"under 40 words"}}
Exactly 3 points with 2 or 3 short examples each. Exactly 3 practice items using this unit's pattern. {romanized_rule}"""
    data = chat_json(
        [{"role": "system", "content": TUTOR_SYSTEM}, {"role": "user", "content": prompt}],
        max_new_tokens=1400,
        temperature=0.4,
    )
    data.setdefault("title", u["title"])
    result = Lesson.model_validate(data)
    path.write_text(json.dumps(result.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def answer(base: Language, target: Language, lesson_title: str, question: str) -> str:
    extra = "" if target.latin else " with a Latin pronunciation in brackets"
    reply = chat(
        [
            {"role": "system", "content": TUTOR_SYSTEM},
            {"role": "user", "content": (
                f"You teach {target.name}. The learner's base language is {base.name}; answer in {base.name} "
                f"(native script), under 120 words. Write {target.name} examples in {target.name} script{extra}.\n"
                f"Current lesson: \"{lesson_title or 'general'}\".\nQuestion: {question}"
            )},
        ],
        max_new_tokens=400,
        temperature=0.5,
    )
    return re.sub(r"[*#`_]+", "", reply).strip()
