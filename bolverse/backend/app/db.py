"""Database connection. PostgreSQL in production; SQLite file for quick local runs."""
from __future__ import annotations

import logging

import os
from collections.abc import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


log = logging.getLogger("bolverse")


class Base(DeclarativeBase):
    pass


def _make_engine():
    url = settings.database_url
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        return create_engine(url, connect_args={"check_same_thread": False})
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20)


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401  (registers tables)

    Base.metadata.create_all(engine)
    _add_missing_columns()
    _add_missing_indexes()
    _encrypt_legacy_rows()


def _add_missing_indexes() -> None:
    """Indexes added to existing tables in newer versions (create_all only builds them for new tables)."""
    insp = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        have = {ix["name"] for ix in insp.get_indexes(table.name)}
        for index in table.indexes:
            if index.name and index.name not in have:
                index.create(engine, checkfirst=True)


def _encrypt_legacy_rows() -> None:
    """One-time upgrade of rows written before encryption at rest: phone numbers, names, dates of birth
    and waiting Connect messages are encrypted, and the plain-text columns get placeholders."""
    from .config import settings
    from .crypto import is_encrypted, phone_key
    from .models import LEGACY_DOB, ConnectMessage, OtpCode, User

    if not settings.encrypt_at_rest:
        return
    with SessionLocal() as db:
        changed = 0
        for user in db.query(User).filter((User.phone_enc.is_(None)) | (User.phone_enc == "")):
            legacy_phone = user.phone_key
            if legacy_phone.startswith("+"):
                user.phone = legacy_phone
            if user.name_legacy and not user.name_enc:
                user.name = user.name_legacy
            if user.dob_legacy and user.dob_legacy != LEGACY_DOB and not user.dob_enc:
                user.dob = user.dob_legacy
            changed += 1
        for otp in db.query(OtpCode).filter(OtpCode.phone.like("+%")):
            otp.phone = phone_key(otp.phone)
        raw = text("SELECT id, original, translation FROM connect_messages")
        for mid, original, translation in db.execute(raw).all():
            if (original and not is_encrypted(original)) or (translation and not is_encrypted(translation)):
                msg = db.get(ConnectMessage, mid)
                msg.original, msg.translation = original or "", translation or ""
                from sqlalchemy.orm.attributes import flag_modified

                flag_modified(msg, "original")
                flag_modified(msg, "translation")
                changed += 1
        db.commit()
        if changed:
            log.info("Encrypted %d existing rows at rest", changed)


def _add_missing_columns() -> None:
    """Small automatic upgrade: adds columns introduced in newer versions to existing tables,
    so a database from an earlier Bolverse keeps working (SQLite and PostgreSQL)."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                sql = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(dialect=engine.dialect)}"
                default = col.default.arg if col.default is not None and not callable(col.default.arg) else None
                if isinstance(default, str):
                    sql += " DEFAULT '" + default.replace("'", "''") + "'"
                elif isinstance(default, (int, float)) and not isinstance(default, bool):
                    sql += f" DEFAULT {default}"
                conn.execute(text(sql))
