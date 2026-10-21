"""Device selection and lazily loaded models (each loaded once, used under a lock)."""
from __future__ import annotations

import logging
import threading
from typing import Callable, Generic, TypeVar

import torch

from .config import settings

log = logging.getLogger("bolverse")
T = TypeVar("T")


def _pick_device() -> str:
    if settings.device != "auto":
        return settings.device
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEVICE = _pick_device()
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


class Lazy(Generic[T]):
    def __init__(self, name: str, loader: Callable[[], T]):
        self.name = name
        self._loader = loader
        self._obj: T | None = None
        self._load_lock = threading.Lock()
        # Serialises inference so concurrent requests don't fight over GPU memory.
        self.run_lock = threading.Lock()

    def get(self) -> T:
        if self._obj is None:
            with self._load_lock:
                if self._obj is None:
                    log.info("Loading %s on %s", self.name, DEVICE)
                    self._obj = self._loader()
                    log.info("Loaded %s", self.name)
        return self._obj

    @property
    def loaded(self) -> bool:
        return self._obj is not None
