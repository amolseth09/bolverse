"""Dashboard accounts from the server's command line.

    python -m app.admin_cli create --email you@example.com --name "Your Name" --role owner
    python -m app.admin_cli reset-password --email you@example.com
    python -m app.admin_cli list

Passwords are typed in (never shown). With Docker:
    docker compose -f docker-compose.api.yml exec api python -m app.admin_cli create --email ... --role owner
"""
from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from .db import SessionLocal, init_db
from .models import AdminUser
from .routes_admin import ROLES, hash_password, password_ok


def _ask_password() -> str:
    while True:
        pw = getpass.getpass("Password (10+ characters, letters and numbers): ")
        if not password_ok(pw):
            print("Too weak. Use at least 10 characters with letters and numbers.")
            continue
        if getpass.getpass("Type it again: ") != pw:
            print("They don't match.")
            continue
        return pw


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.admin_cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--email", required=True)
    c.add_argument("--name", default="Owner")
    c.add_argument("--role", choices=ROLES, default="owner")
    r = sub.add_parser("reset-password")
    r.add_argument("--email", required=True)
    sub.add_parser("list")
    args = p.parse_args(argv)
    init_db()
    with SessionLocal() as db:
        if args.cmd == "list":
            for a in db.scalars(select(AdminUser).order_by(AdminUser.created_at)):
                print(f"{a.email:35} {a.role:8} {'active' if a.active else 'disabled'}")
            return 0
        email = args.email.strip().lower()
        admin = db.scalar(select(AdminUser).where(AdminUser.email == email))
        if args.cmd == "create":
            if admin:
                print("That email already has a dashboard account. Use reset-password.")
                return 1
            db.add(AdminUser(email=email, name=args.name, role=args.role, password_hash=hash_password(_ask_password())))
            db.commit()
            print(f"Created {args.role} {email}.")
            return 0
        if admin is None:
            print("No dashboard account with that email.")
            return 1
        admin.password_hash, admin.locked_until, admin.failed_logins, admin.active = hash_password(_ask_password()), None, 0, True
        db.commit()
        print(f"Password reset for {email}.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
