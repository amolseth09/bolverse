"""Writes each course day with the LLM (in three smaller calls, which small models handle reliably)
and runs live role-play conversations. Days are cached on disk: every later learner of the same
language pair, pattern and length gets them instantly."""
from __future__ import annotations

import json
from pathlib import Path

from ..config import settings
from ..courses import TRACKS, plan, section_minutes, sizes
from ..languages import Language
from ..schemas import DayContent, Item, RoleplayOut
from .llm import chat_json

SYSTEM = (
    "You are Bolverse, a warm, encouraging spoken language tutor. Your words are read aloud by text-to-speech, "
    "so write short natural sentences with no markdown, lists, emojis or symbols. Always reply with valid JSON only."
)


def _cache_path(base: Language, target: Language, track: str, days: int, minutes: int, day: int) -> Path:
    folder = Path(settings.data_dir) / "courses" / f"{base.code}__{target.code}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{track}_{days}d_{minutes}m_day{day:02d}.json"


def _context(base: Language, target: Language, track_id: str, days: int, day: int) -> tuple[str, dict]:
    track = TRACKS[track_id]
    outline = plan(track_id, days)
    today = outline[day - 1]
    earlier = "; ".join(d["grammar"] for d in outline[: day - 1][-6:]) or "nothing yet (this is day 1)"
    latin = (f"Every \"romanized\" field must be \"\" because {target.name} uses the Latin alphabet."
             if target.latin else f"Every \"romanized\" field is a simple Latin-letter pronunciation guide for the {target.name} text.")
    ctx = (
        f"The learner speaks {base.name} and is learning {target.name} for this situation: {track.title}. "
        f"Focus on {track.depth}.\n"
        f"This is day {day} of a {days}-day course. Today's scene: \"{today['scene']}\". "
        f"Today's grammar: \"{today['grammar']}\". Recently covered: {earlier}.\n"
        f"Write all explanations, hints, meanings and feedback in {base.name} ({base.native} script). "
        f"Write all {target.name} text in its native script ({target.native}). {latin}"
    )
    return ctx, today


def _ask(ctx: str, task: str, max_tokens: int) -> dict:
    return chat_json([{"role": "system", "content": SYSTEM}, {"role": "user", "content": ctx + "\n\n" + task}],
                     max_new_tokens=max_tokens, temperature=0.4)


def build_day(base: Language, target: Language, track_id: str, days: int, minutes: int, day: int,
              refresh: bool = False) -> DayContent:
    path = _cache_path(base, target, track_id, days, minutes, day)
    if path.exists() and not refresh:
        return DayContent.model_validate_json(path.read_text(encoding="utf-8"))

    ctx, today = _context(base, target, track_id, days, day)
    n = sizes(minutes, detailed=track_id in ("stay", "move"))

    # 1. Explanation, vocabulary and phrases
    part1 = _ask(ctx, (
        "Create today's lesson. JSON shape:\n"
        '{"title": "short title in the learner\'s language", "goal": "one sentence: what they can do after today", '
        '"intro": "2 or 3 spoken sentences welcoming them to today\'s scene", '
        '"lesson": [{"rule": "clear explanation of the grammar point, comparing with the learner\'s language where it helps", '
        '"examples": [{"target": "...", "romanized": "...", "meaning": "..."}]}], '
        '"vocabulary": [{"target": "...", "romanized": "...", "meaning": "..."}], '
        '"phrases": [{"target": "useful full sentence for the scene", "romanized": "...", "meaning": "..."}], '
        '"recap": "2 spoken sentences summing up today"}\n'
        f'Exactly {n["rules"]} lesson items with 2 or 3 short examples each, {n["vocab"]} vocabulary words for the scene, '
        f'and {n["phrases"]} phrases. Keep each rule under 70 words.'
    ), 2200)

    # 2. Role-play script
    part2 = _ask(ctx, (
        "Write a role-play for today's scene where the learner practises out loud. JSON shape:\n"
        '{"setting": "one sentence in the learner\'s language", "bot_role": "who the tutor plays", '
        '"learner_role": "who the learner plays", "turns": [{"bot": {"target": "...", "romanized": "...", "meaning": "..."}, '
        '"learner_hint": "in the learner\'s language: what to say next", '
        '"learner_answer": {"target": "a good reply using today\'s grammar", "romanized": "...", "meaning": ""}}]}\n'
        f'Exactly {n["turns"]} turns. Keep every line short and natural.'
    ), 1600)

    # 3. Quiz
    part3 = _ask(ctx, (
        "Write a short quiz on today's grammar and words. JSON shape:\n"
        '{"quiz": [{"question": "in the learner\'s language", "options": ["four", "short", "choices", "here"], '
        '"answer_index": 0, "explanation": "one sentence in the learner\'s language"}]}\n'
        f'Exactly {n["quiz"]} questions, 4 options each, correct answer in varied positions.'
    ), 900)

    content = DayContent.model_validate({
        **part1, "roleplay": part2 or None, "quiz": part3.get("quiz", []),
        "day": day, "days": days, "track": track_id, "scene": today["scene"], "grammar": today["grammar"],
        "minutes": section_minutes(minutes), "title": part1.get("title") or today["scene"],
    })
    if target.latin:  # small models sometimes fill these anyway
        for item in [*content.vocabulary, *content.phrases, *[e for r in content.lesson for e in r.examples]]:
            item.romanized = ""
    for q in content.quiz:
        q.answer_index = min(max(q.answer_index, 0), max(len(q.options) - 1, 0))
    path.write_text(json.dumps(content.model_dump(), ensure_ascii=False, indent=1), encoding="utf-8")
    return content


def roleplay_turn(base: Language, target: Language, track_id: str, days: int, day: int,
                  history: list[dict], user_text: str) -> RoleplayOut:
    ctx, today = _context(base, target, track_id, days, day)
    transcript = "\n".join(f'{"Tutor" if h["role"] == "bot" else "Learner"}: {h["text"]}' for h in history[-12:])
    data = _ask(ctx, (
        f"You are role-playing today's scene with the learner and staying in character.\n"
        f"Conversation so far:\n{transcript or '(just starting)'}\nLearner: {user_text}\n\n"
        "Reply in character with one or two short sentences in the target language, at the learner's level. "
        "Also give gentle feedback on the learner's last line. JSON shape:\n"
        '{"reply": {"target": "...", "romanized": "...", "meaning": "in the learner\'s language"}, '
        '"feedback": "one encouraging sentence in the learner\'s language", '
        '"corrected": "a more natural version of the learner\'s line in the target language, or \"\" if it was fine"}'
    ), 500)
    out = RoleplayOut(reply=Item.model_validate(data.get("reply") or {"target": str(data.get("text", ""))}),
                      feedback=str(data.get("feedback", "")), corrected=str(data.get("corrected", "")))
    if target.latin:
        out.reply.romanized = ""
    return out
