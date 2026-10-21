"""Small in-memory sliding-window rate limiter for the sign-in endpoints.

It counts per server process. That's right for one API server (the Oracle VM setup); with several API
servers behind a load balancer, move this to Redis or the database. The database-backed daily limits in
routes_auth (codes per number and per IP per day) apply across processes either way."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

_hits: dict[str, deque[float]] = defaultdict(deque)
_lock = threading.Lock()


def allow(key: str, limit: int, window_seconds: float) -> bool:
    """Records a hit and returns False if `key` already had `limit` hits in the window."""
    now = time.monotonic()
    with _lock:
        q = _hits[key]
        while q and q[0] <= now - window_seconds:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(_hits) > 50_000:  # forget idle keys so memory stays bounded
            for k in [k for k, v in _hits.items() if not v or v[-1] <= now - 3600][:10_000]:
                _hits.pop(k, None)
        return True


def reset() -> None:
    with _lock:
        _hits.clear()
