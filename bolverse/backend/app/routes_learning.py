"""Courses, progress, personal vocabulary and recognition corrections."""
from __future__ import annotations

import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .courses import MAX_MINUTES_PER_DAY, TRACKS, plan, tracks_view
from .db import get_db
from .entitlements import Actor, check_course_day, get_actor, owner_key, problem
from .languages import Language, find
from .models import Correction, Enrollment, VocabTerm
from .schemas import CorrectionIn, CourseIn, DayContent, DayIn, ProgressIn, RoleplayIn, RoleplayOut, VocabIn
from .security import utcnow
from .services.vocab import new_terms

router = APIRouter(tags=["personal words"])
course_router = APIRouter(tags=["learning (switched off unless BOLVERSE_LEARNING_ENABLED=true)"])
MAX_TERMS = 200


def _lang(code: str) -> Language:
    lang = find(code)
    if not lang:
        raise HTTPException(400, f"Unsupported language: {code}")
    return lang


def _pair(body: CourseIn) -> tuple[Language, Language]:
    base, target = _lang(body.base), _lang(body.target)
    if base.nllb == target.nllb:
        raise problem(400, "same_language", "Pick a language different from your own.")
    return base, target


# ---------- Personal vocabulary and corrections ----------

def terms_for(db: Session, actor: Actor, language: str) -> list[str]:
    return list(db.scalars(select(VocabTerm.term).where(VocabTerm.owner == owner_key(actor), VocabTerm.language == language)
                           .order_by(VocabTerm.created_at.desc()).limit(MAX_TERMS)))


def _add_terms(db: Session, actor: Actor, language: str, terms: list[str]) -> list[str]:
    existing = {t.lower() for t in terms_for(db, actor, language)}
    added = [t for t in terms if t.lower() not in existing]
    for t in added:
        db.add(VocabTerm(owner=owner_key(actor), language=language, term=t[:80]))
    return added


@router.get("/vocab")
def list_vocab(language: str, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    rows = db.scalars(select(VocabTerm).where(VocabTerm.owner == owner_key(actor), VocabTerm.language == language)
                      .order_by(VocabTerm.created_at.desc()))
    return [{"id": r.id, "term": r.term} for r in rows]


@router.post("/vocab")
def add_vocab(body: VocabIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    _lang(body.language)
    added = _add_terms(db, actor, body.language, [" ".join(body.term.split())])
    db.commit()
    return {"added": added}


@router.delete("/vocab/{term_id}")
def delete_vocab(term_id: int, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    db.execute(delete(VocabTerm).where(VocabTerm.id == term_id, VocabTerm.owner == owner_key(actor)))
    db.commit()
    return {"ok": True}


@router.post("/corrections")
def correct(body: CorrectionIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    """The user fixed a mishearing. Learn their words; keep the pair only if they agreed to share it."""
    _lang(body.language)
    added = _add_terms(db, actor, body.language, new_terms(body.heard, body.corrected))
    if body.consent:
        db.add(Correction(owner=owner_key(actor), language=body.language, heard=body.heard,
                          corrected=body.corrected, consent=True))
    db.commit()
    return {"learned": added}


# ---------- Courses ----------

@course_router.get("/courses/tracks")
def tracks():
    return tracks_view()


@course_router.post("/courses/plan")
def course_plan(body: CourseIn):
    _pair(body)
    return {"track": body.track, "days": body.days, "minutes": body.minutes, "plan": plan(body.track, body.days)}


def _view(e: Enrollment, actor: Actor) -> dict:
    done = sorted(json.loads(e.completed_days or "[]"))
    log = json.loads(e.minutes_log or "{}")
    today = log.get(date.today().isoformat(), 0)
    next_day = next((d for d in range(1, e.days + 1) if d not in done), None)
    from .config import settings
    free_days = None if (actor.premium or not settings.accounts_enabled) else settings.free_course_days
    return {
        "id": e.id, "base": e.base, "target": e.target, "track": e.track, "days": e.days, "minutes": e.minutes,
        "completed_days": done, "next_day": next_day, "finished": next_day is None,
        "minutes_today": today, "daily_goal": e.minutes, "daily_limit": MAX_MINUTES_PER_DAY,
        "limit_reached": today >= MAX_MINUTES_PER_DAY, "total_minutes": sum(log.values()),
        "streak": _streak(log), "free_days": free_days,
        "started_at": e.started_at.isoformat() + "Z", "plan": plan(e.track, e.days),
    }


def _streak(log: dict) -> int:
    from datetime import timedelta
    day, count = date.today(), 0
    if log.get(day.isoformat(), 0) == 0:
        day -= timedelta(days=1)  # today not started yet doesn't break the streak
    while log.get(day.isoformat(), 0) > 0:
        count += 1
        day -= timedelta(days=1)
    return count


def _mine(db: Session, actor: Actor, enrollment_id: str) -> Enrollment:
    e = db.get(Enrollment, enrollment_id)
    if e is None or e.owner != owner_key(actor):
        raise HTTPException(404, "Course not found.")
    return e


@course_router.post("/courses/enroll")
def enroll(body: CourseIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    _pair(body)
    e = Enrollment(owner=owner_key(actor), base=body.base, target=body.target, track=body.track,
                   days=body.days, minutes=body.minutes)
    db.add(e)
    db.commit()
    return _view(e, actor)


@course_router.get("/courses/mine")
def my_courses(db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    rows = db.scalars(select(Enrollment).where(Enrollment.owner == owner_key(actor)).order_by(Enrollment.updated_at.desc()))
    return [_view(e, actor) for e in rows]


@course_router.delete("/courses/{enrollment_id}")
def leave(enrollment_id: str, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    db.delete(_mine(db, actor, enrollment_id))
    db.commit()
    return {"ok": True}


@course_router.post("/courses/{enrollment_id}/progress")
def progress(enrollment_id: str, body: ProgressIn, db: Session = Depends(get_db), actor: Actor = Depends(get_actor)):
    e = _mine(db, actor, enrollment_id)
    if body.day > e.days:
        raise HTTPException(400, "That day isn't part of this course.")
    log = json.loads(e.minutes_log or "{}")
    key = date.today().isoformat()
    log[key] = min(MAX_MINUTES_PER_DAY * 2, log.get(key, 0) + body.minutes_spent)
    e.minutes_log = json.dumps(log)
    if body.completed:
        done = set(json.loads(e.completed_days or "[]"))
        done.add(body.day)
        e.completed_days = json.dumps(sorted(done))
    e.updated_at = utcnow()
    db.commit()
    return _view(e, actor)


@course_router.post("/courses/day", response_model=DayContent)
def course_day(body: DayIn, actor: Actor = Depends(get_actor)):
    base, target = _pair(body)
    if body.day > body.days:
        raise HTTPException(400, "That day isn't part of this course.")
    check_course_day(actor, body.day)
    from .services import course_ai
    return course_ai.build_day(base, target, body.track, body.days, body.minutes, body.day, body.refresh)


@course_router.post("/courses/roleplay", response_model=RoleplayOut)
def roleplay(body: RoleplayIn, actor: Actor = Depends(get_actor)):
    base, target = _pair(body)
    check_course_day(actor, body.day)
    from .services import course_ai
    return course_ai.roleplay_turn(base, target, body.track, body.days, body.day,
                                   [h.model_dump() for h in body.history], body.user_text)
