"""Course patterns and the day-by-day curriculum.

Every course follows the same grammar ladder (one step per day), set in scenes that fit the
learner's situation. Shorter courses (15 or 21 days) take evenly spaced steps from the 30-day ladder,
so they cover the same ground faster. The "stay" and "move" patterns teach in more depth.
"""
from __future__ import annotations

from dataclasses import dataclass

DURATIONS = (15, 21, 30)
DAILY_MINUTES = (20, 40, 60)
MAX_MINUTES_PER_DAY = 60

GRAMMAR = [
    "Sounds, script and polite greetings",
    "Introducing yourself: I am, my name is, I'm from",
    "Numbers, prices and paying",
    "This and that: asking what something is",
    "Question words: where, what, when, how much",
    "Polite requests: I would like, please give me",
    "Present tense of everyday verbs",
    "Saying no: negation and 'there isn't'",
    "Directions and places: left, right, near, far",
    "Time, days and making plans",
    "Describing things with adjectives",
    "Can and cannot: ability and permission",
    "Past tense: what happened",
    "Future: I will, I'm going to",
    "Review day: putting it all together",
    "Plurals and counting things",
    "Likes, dislikes and preferences",
    "Comparisons: more, less, better, the best",
    "Need, must and have to",
    "Possessives: my, your, our, their",
    "Describing problems and making complaints",
    "Giving opinions, agreeing and disagreeing",
    "Linking ideas: because, but, so, although",
    "Ongoing actions and what's been happening",
    "Formal and informal speech, levels of politeness",
    "Asking for help and checking you understood",
    "Telling a short story in the past",
    "Making, changing and cancelling arrangements",
    "Natural expressions and phrases locals use",
    "Final review and a confident conversation",
]


@dataclass(frozen=True)
class Track:
    id: str
    emoji: str
    title: str
    tagline: str
    depth: str  # what the tutor should emphasise
    scenes: tuple[str, ...]


TRACKS: dict[str, Track] = {t.id: t for t in [
    Track("holiday", "🏖️", "Holiday trip", "Get around, eat well, shop, and make friends on your trip.",
          "practical survival phrases a tourist needs, kept short and friendly", (
        "Landing at the airport and passport control", "Checking in at your hotel or homestay",
        "Changing money and buying a SIM card", "At a street food stall", "Asking the way to famous sights",
        "Ordering a meal at a restaurant", "Taking a taxi or ride-share", "Buying train and bus tickets",
        "Lost in the old town", "Booking a day tour", "Shopping for clothes and souvenirs", "At the pharmacy",
        "Chatting about your trip so far", "Planning tomorrow's day trip", "A day at the beach or in the hills",
        "Bargaining at the market", "Food you love and food you can't eat", "Choosing between two hotels",
        "An emergency: doctor or police", "Making friends with locals", "A problem with your hotel room",
        "A local festival", "Buying tickets for a show or nightlife", "Asking someone to take your photo",
        "Visiting a family home: customs and manners", "Reporting lost belongings",
        "Telling new friends about your travels", "Changing a booking", "Local slang at a café",
        "Checking out and saying goodbye")),
    Track("business", "💼", "Business trip", "Meet clients, run meetings, and build trust in their language.",
          "professional, polite language for meetings, email and client relationships", (
        "Arrival and the business visa check", "Introductions and exchanging business cards",
        "Prices, currencies and quotes", "Office and company vocabulary", "Setting up a meeting",
        "Ordering at a business lunch", "Talking about your job and company", "Saying no politely",
        "Finding the client's office", "Calendars and scheduling", "Describing your product",
        "Asking for approvals and permissions", "Reporting last quarter's results", "Targets and future plans",
        "Opening a presentation", "Orders, quantities and delivery", "Understanding what the client needs",
        "Comparing offers and competitors", "Deadlines and obligations", "Our company and yours",
        "Handling a complaint", "Opinions in a meeting", "Negotiation basics", "Updates on a running project",
        "Speaking with senior people", "Clarifying on a phone or video call", "A two-minute pitch",
        "Rescheduling and following up", "Networking, small talk and etiquette", "Closing the deal")),
    Track("stay", "🏡", "Staying a few months", "Rent, shop, bank, see a doctor, and get along with neighbours.",
          "detailed everyday-life language for a longer stay, with fuller grammar explanations and more vocabulary", (
        "Arriving and settling in", "Meeting your landlord and neighbours", "Getting a local SIM and paying bills",
        "Grocery shopping: what is this?", "Finding services near you", "Opening a bank account",
        "Your daily routine", "Home problems: no water, no internet", "Commuting by public transport",
        "Weekly schedules and appointments", "Describing your flat", "Building rules: what you can and can't do",
        "Your first weeks: what happened", "Plans for the coming months", "Small talk with neighbours",
        "Cooking and buying in quantities", "Joining a gym, class or club", "Choosing between plans and offers",
        "Registration and paperwork you must do", "Family and personal life", "Seeing a doctor and describing symptoms",
        "Local news and your opinions", "Explaining reasons and excuses", "What's been happening lately",
        "Being polite with officials", "Asking strangers for help", "Stories from home",
        "Arranging repairs and deliveries", "Local expressions", "Confident everyday life")),
    Track("move", "🌍", "Moving permanently", "Settle for good: work, paperwork, schools, healthcare, and belonging.",
          "in-depth language for building a life there: formal and informal registers, official situations, "
          "workplace culture and idioms, with thorough grammar explanations", (
        "Your first days in a new country", "Introducing yourself at work and in the neighbourhood",
        "Rent, salary and money", "Setting up your home", "City offices and services",
        "Applying for residence or registration", "Routines at work", "Solving problems and missing things",
        "Commuting and driving basics", "Official appointments and schedules", "Describing people and places",
        "Rights and rules: what you can and must not do", "Your background and past", "Long-term goals",
        "Introducing your new life", "Contracts, shopping and quantities", "Culture, food and preferences",
        "Comparing schools, neighbourhoods and insurance", "Taxes, bills and obligations",
        "Family, children and school", "The healthcare system and emergencies", "Discussions and opinions at work",
        "Writing emails and messages", "Ongoing situations and updates", "Formal language with authorities",
        "Clearing up misunderstandings", "Telling your life story", "Planning events and invitations",
        "Idioms, humour and local culture", "Feeling at home: fluent everyday conversations")),
]}


def ladder_index(day: int, days: int) -> int:
    """Map day 1..days onto the 30-step ladder, always starting at step 0 and ending at step 29."""
    if days <= 1:
        return 0
    return round((day - 1) * (len(GRAMMAR) - 1) / (days - 1))


def plan(track_id: str, days: int) -> list[dict]:
    track = TRACKS[track_id]
    out = []
    for day in range(1, days + 1):
        i = ladder_index(day, days)
        out.append({"day": day, "scene": track.scenes[i], "grammar": GRAMMAR[i],
                    "review": i in (14, 29) or day == days})
    return out


def section_minutes(total: int) -> dict[str, int]:
    """Split the daily time the way a 60-minute day is split: 5/15/10/10/15/5."""
    shares = {"review": 5, "lesson": 15, "vocabulary": 10, "listen_repeat": 10, "roleplay": 15, "quiz": 5}
    scaled = {k: max(2, round(v * total / 60)) for k, v in shares.items()}
    scaled["lesson"] += total - sum(scaled.values())
    return scaled


def sizes(minutes: int, detailed: bool) -> dict[str, int]:
    """How much content fits in the chosen daily time."""
    base = {20: dict(rules=1, vocab=8, phrases=4, turns=4, quiz=4),
            40: dict(rules=2, vocab=12, phrases=6, turns=6, quiz=5),
            60: dict(rules=3, vocab=15, phrases=8, turns=8, quiz=6)}[minutes]
    if detailed:
        base = {**base, "vocab": base["vocab"] + 3, "phrases": base["phrases"] + 2}
    return base


def tracks_view() -> list[dict]:
    return [{"id": t.id, "emoji": t.emoji, "title": t.title, "tagline": t.tagline,
             "durations": list(DURATIONS), "daily_minutes": list(DAILY_MINUTES),
             "recommended_days": 30 if t.id in ("stay", "move") else 21} for t in TRACKS.values()]
