"""Encryption at rest for sensitive fields (message text, names, dates of birth, phone numbers).

- AES-256-GCM from the `cryptography` package (a vetted library; no home-made cipher). Each value gets
  a fresh 96-bit nonce; the authentication tag means a tampered value fails to decrypt instead of
  returning garbage.
- Stored as "v1.<key id>.<base64(nonce + ciphertext)>". The key id lets you rotate keys: put the new
  key in BOLVERSE_DATA_KEY and the old one(s) in BOLVERSE_DATA_KEYS_OLD; old rows still decrypt and are
  re-encrypted with the new key whenever they're saved again.
- Values written by older versions (plain text) are read as they are, so upgrading needs no downtime.
- Phone numbers also get a "blind index": a keyed hash used to look a user up by number without
  storing the number in the clear.

Key: BOLVERSE_DATA_KEY (32 random bytes, base64). Generate one with
    python -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"
Without it the key is derived from BOLVERSE_SECRET_KEY, and in development from a key file in the data
folder. LOSING THE KEY MEANS LOSING THE ENCRYPTED DATA: back it up separately from the database.

Note on the trust model: the server translates messages, so it necessarily sees message text while it
works on it. This protects the stored copy (database files, backups, a leaked dump), not the content
from the server itself. See README "Privacy and encryption".
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy.types import Text, TypeDecorator

from .config import settings

log = logging.getLogger("bolverse")
PREFIX = "v1."


class KeyError_(RuntimeError):
    pass


def _decode_key(raw: str) -> bytes:
    try:
        key = base64.b64decode(raw.strip(), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise KeyError_("BOLVERSE_DATA_KEY must be 32 random bytes in base64.") from exc
    if len(key) != 32:
        raise KeyError_("BOLVERSE_DATA_KEY must be exactly 32 bytes (44 base64 characters).")
    return key


def _derive(material: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=SHA256(), length=32, salt=b"bolverse-data-v1", info=info).derive(material)


def _file_key() -> bytes:
    path = os.path.join(settings.data_dir or ".", "data_key")
    if os.path.exists(path):
        return _decode_key(open(path).read())
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    key = os.urandom(32)
    with open(path, "w") as f:
        f.write(base64.b64encode(key).decode())
    os.chmod(path, 0o600)
    log.warning("No BOLVERSE_DATA_KEY: created %s. Back it up; encrypted data can't be read without it.", path)
    return key


@lru_cache(maxsize=1)
def _keys() -> tuple[bytes, dict[str, bytes]]:
    """(current key, {key id: key}) including old keys kept for decryption."""
    if settings.data_key:
        current = _decode_key(settings.data_key)
    elif settings.secret_key:
        current = _derive(settings.secret_key.encode(), b"data-key")
    elif settings.app_env == "production":
        raise KeyError_("Set BOLVERSE_DATA_KEY (or BOLVERSE_SECRET_KEY) in production.")
    else:
        current = _file_key()
    ring = {key_id(current): current}
    for raw in settings.data_keys_old:
        k = _decode_key(raw)
        ring.setdefault(key_id(k), k)
    return current, ring


def key_id(key: bytes) -> str:
    return hashlib.sha256(b"kid" + key).hexdigest()[:8]


def encrypt(plain: str) -> str:
    current, _ = _keys()
    nonce = os.urandom(12)
    ct = AESGCM(current).encrypt(nonce, plain.encode("utf-8"), None)
    return f"{PREFIX}{key_id(current)}.{base64.b64encode(nonce + ct).decode()}"


def decrypt(stored: str) -> str:
    if not stored.startswith(PREFIX):
        return stored  # written before encryption was turned on
    try:
        _, kid, blob = stored.split(".", 2)
        key = _keys()[1][kid]
        raw = base64.b64decode(blob)
        return AESGCM(key).decrypt(raw[:12], raw[12:], None).decode("utf-8")
    except KeyError:
        log.error("A value was encrypted with an unknown key (%s). Add the old key to BOLVERSE_DATA_KEYS_OLD.", stored[3:11])
        raise
    except Exception:
        log.error("A stored value failed to decrypt (tampered or wrong key).")
        raise


def is_encrypted(stored: str | None) -> bool:
    return bool(stored) and stored.startswith(PREFIX)


@lru_cache(maxsize=1)
def _index_key() -> bytes:
    return _derive(_keys()[0], b"phone-index")


def phone_key(e164: str) -> str:
    """Blind index for a phone number: 20 characters, the same every time for the same number."""
    return "h" + hmac.new(_index_key(), e164.encode(), hashlib.sha256).hexdigest()[:19]


class EncryptedText(TypeDecorator):
    """A Text column that is encrypted in the database and plain text in Python."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt(str(value)) if settings.encrypt_at_rest and value != "" else value

    def process_result_value(self, value, dialect):
        if value is None or value == "":
            return value
        return decrypt(value)
