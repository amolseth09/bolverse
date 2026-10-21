"""How close a learner's spoken attempt was to the expected sentence."""
from __future__ import annotations

import re
import unicodedata

_STRIP = re.compile(r"[\s.,!?¿¡;:'\"“”‘’、。，！？।॥()\-]")


def _norm(s: str) -> str:
    return _STRIP.sub("", unicodedata.normalize("NFC", s or "").lower())


def similarity(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))


def verdict(score: float) -> str:
    return "good" if score >= 0.8 else "close" if score >= 0.55 else "retry"
