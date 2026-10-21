from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class LanguageOut(BaseModel):
    code: str
    name: str
    native: str
    hello: str
    latin: bool
    server_voice: bool


class TranslateIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    source: str
    target: str
    speaker: Literal["me", "them"] = "me"
    speaker_gender: Literal["male", "female"] | None = None  # for "them"; "me" uses the profile


class TranslateOut(BaseModel):
    translation: str
    romanized: str = ""
    source_text: str = ""  # the input as understood, e.g. Hinglish converted to Devanagari


class ConverseOut(TranslateOut):
    original: str
    speaker_gender: Literal["male", "female"] | None = None  # the gender used for wording and voice


class AskOut(BaseModel):
    question: str            # what the user said or typed
    source_text: str         # as understood (Hinglish converted to its script)
    translation: str         # in the chosen language, worded for the user's gender
    native_reading: str = "" # how it sounds, in the user's own script
    english_reading: str = "" # how it sounds, in English letters
    target: str
    voice_gender: Literal["male", "female"] | None = None


class TranscribeOut(BaseModel):
    text: str


class TTSIn(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    language: str
    rate: float = Field(1.0, ge=0.5, le=2.0)
    gender: Literal["male", "female"] | None = None


class VoiceOut(BaseModel):
    language: str
    available: bool


class Example(BaseModel):
    target: str
    romanized: str = ""
    meaning: str = ""


class Point(BaseModel):
    rule: str
    examples: list[Example] = []


class Practice(BaseModel):
    prompt: str
    answer: str
    romanized: str = ""


class Lesson(BaseModel):
    title: str
    intro: str = ""
    points: list[Point] = []
    practice: list[Practice] = []
    recap: str = ""


class LessonIn(BaseModel):
    base: str
    target: str
    unit: int = Field(ge=0)
    refresh: bool = False


class TutorIn(BaseModel):
    base: str
    target: str
    lesson_title: str = ""
    question: str = Field(min_length=1, max_length=1000)


class TutorOut(BaseModel):
    answer: str


class ScoreOut(BaseModel):
    heard: str
    score: float
    verdict: Literal["good", "close", "retry"]


# ---------- Courses ----------

class Item(BaseModel):
    target: str
    romanized: str = ""
    meaning: str = ""


class Rule(BaseModel):
    rule: str
    examples: list[Item] = []


class RoleTurn(BaseModel):
    bot: Item
    learner_hint: str = ""        # in the learner's language: what to say next
    learner_answer: Item          # a good answer in the target language


class Roleplay(BaseModel):
    setting: str
    bot_role: str
    learner_role: str
    turns: list[RoleTurn] = []


class QuizQuestion(BaseModel):
    question: str
    options: list[str]
    answer_index: int = 0
    explanation: str = ""


class DayContent(BaseModel):
    day: int
    days: int
    track: str
    scene: str
    grammar: str
    title: str
    goal: str = ""
    intro: str = ""
    minutes: dict[str, int] = {}
    lesson: list[Rule] = []
    vocabulary: list[Item] = []
    phrases: list[Item] = []
    roleplay: Roleplay | None = None
    quiz: list[QuizQuestion] = []
    recap: str = ""


class CourseIn(BaseModel):
    base: str
    target: str
    track: Literal["holiday", "business", "stay", "move"]
    days: Literal[15, 21, 30] = 21
    minutes: Literal[20, 40, 60] = 40


class DayIn(CourseIn):
    day: int = Field(ge=1, le=30)
    refresh: bool = False


class ChatLine(BaseModel):
    role: Literal["bot", "learner"]
    text: str = Field(max_length=500)


class RoleplayIn(DayIn):
    history: list[ChatLine] = Field(default=[], max_length=30)
    user_text: str = Field(min_length=1, max_length=500)


class RoleplayOut(BaseModel):
    reply: Item
    feedback: str = ""       # one friendly sentence in the learner's language
    corrected: str = ""      # a better version of what the learner said, in the target language


class ProgressIn(BaseModel):
    day: int = Field(ge=1, le=30)
    minutes_spent: int = Field(0, ge=0, le=120)
    completed: bool = False


class VocabIn(BaseModel):
    language: str
    term: str = Field(min_length=2, max_length=80)


class CorrectionIn(BaseModel):
    language: str
    heard: str = Field(max_length=1000)
    corrected: str = Field(min_length=1, max_length=1000)
    consent: bool = False  # allow keeping this pair to improve recognition for everyone
