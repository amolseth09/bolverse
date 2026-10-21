"""Light text helpers used by the accounts server as well as the AI engine (no AI libraries needed)."""
from __future__ import annotations

import re

from anyascii import anyascii

from ..languages import Language


def is_romanized(text: str, lang: Language) -> bool:
    """True when a language with its own script (Hindi, Arabic, Russian...) was typed in Latin letters."""
    if lang.latin:
        return False
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 2:
        return False
    return sum(c.isascii() for c in letters) / len(letters) > 0.6


def romanize(text: str, lang: Language) -> str:
    """Rough Latin-letter reading; empty for languages already written in Latin script."""
    if lang.latin or not text:
        return ""
    return re.sub(r"\s+", " ", anyascii(text)).strip()
