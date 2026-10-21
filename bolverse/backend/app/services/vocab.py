"""Personal vocabulary: words a user taught Bolverse by correcting it (names, places, hotels).

When recognition returns something close to a known word, it is replaced with the user's spelling.
"""
from __future__ import annotations

import re

from .scoring import similarity

_WORD = re.compile(r"\w+", re.UNICODE)
MIN_SIMILARITY = 0.78


def apply_vocabulary(text: str, terms: list[str]) -> str:
    if not text or not terms:
        return text
    tokens = list(_WORD.finditer(text))
    replacements: list[tuple[int, int, str]] = []
    used = [False] * len(tokens)
    for term in sorted(set(terms), key=lambda t: -len(t.split())):
        n = len(term.split())
        if n == 0 or len(term) < 3:
            continue
        squashed_term = term.replace(" ", "")
        # Also try one extra word: recognition often splits a name ("sun rice" for "Sunrise").
        for width in (n, n + 1):
            for i in range(len(tokens) - width + 1):
                if any(used[i:i + width]):
                    continue
                start, end = tokens[i].start(), tokens[i + width - 1].end()
                chunk = text[start:end]
                if chunk == term:
                    for k in range(i, i + width):
                        used[k] = True
                    continue
                if similarity(chunk.replace(" ", ""), squashed_term) >= MIN_SIMILARITY:
                    replacements.append((start, end, term))
                    for k in range(i, i + width):
                        used[k] = True
    for start, end, term in sorted(replacements, reverse=True):
        text = text[:start] + term + text[end:]
    return text


def new_terms(heard: str, corrected: str) -> list[str]:
    """Words the user typed in a correction that recognition got wrong."""
    heard_words = {w.lower() for w in _WORD.findall(heard)}
    words = [w for w in _WORD.findall(corrected) if len(w) >= 3 and w.lower() not in heard_words and not w.isdigit()]
    out = list(dict.fromkeys(words))
    if 1 < len(corrected.split()) <= 3 and corrected.strip() not in out:
        out.append(corrected.strip())  # short phrases like a hotel name are useful whole
    return out[:10]
