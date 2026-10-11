#!/usr/bin/env python
"""Create and set up a FinTrace PostgreSQL database.

Idempotent: run it against nothing and it builds everything; run it again and it
brings an existing database up to date. It never drops or rewrites data.

What it does, in order:
  1. Creates the roles (owner, app, worker, auditor) or updates their passwords.
  2. Creates the database, owned by the NOLOGIN owner role.
  3. Loads schema.sql into an empty database, or applies db/patches/*.sql to an
     existing one.
  4. Creates Django's own tables (sessions, auth, content types, cache).
  5. Applies the runtime grants from grant_permissions.sql.
  6. Optionally seeds currencies and a first user with their own workspace.
  7. Verifies the result by connecting as the runtime role.

Typical use (development):

    python scripts/bootstrap_db.py --seed-currencies \\
        --admin-email you@example.com --workspace-name "Home" --workspace-currency USD

Connection settings come from the environment (a .env file is loaded if present):

    DATABASE_HOST, DATABASE_PORT, DATABASE_NAME      where the database lives
    DATABASE_USER, DATABASE_PASSWORD                 the runtime (app) role to create
    FINTRACE_DB_ADMIN_USER, FINTRACE_DB_ADMIN_PASSWORD   a superuser used only by this script
    FINTRACE_DB_ADMIN_DATABASE                       maintenance database (default: postgres)
    FINTRACE_WORKER_PASSWORD, FINTRACE_AUDITOR_PASSWORD  optional; without them those roles cannot log in
    FINTRACE_ADMIN_PASSWORD                          password for --admin-email (prompted if absent)
"""
import argparse
import getpass
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from dotenv import dotenv_values, load_dotenv

    load_dotenv(ROOT / ".env", override=True)
except ImportError:  # python-dotenv is optional
    dotenv_values = None

import psycopg
from psycopg import sql

OWNER_ROLE = "fintrace_owner"
WORKER_ROLE = "fintrace_worker"
AUDITOR_ROLE = "fintrace_auditor"
ROLE_ATTRIBUTES = "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"

# ISO 4217 code, name, symbol, decimal places
CURRENCIES = [
    ("USD", "US Dollar", "$", 2), ("EUR", "Euro", "€", 2), ("GBP", "Pound Sterling", "£", 2),
    ("INR", "Indian Rupee", "₹", 2), ("CAD", "Canadian Dollar", "CA$", 2), ("AUD", "Australian Dollar", "A$", 2),
    ("SGD", "Singapore Dollar", "S$", 2), ("AED", "UAE Dirham", "AED", 2), ("CHF", "Swiss Franc", "CHF", 2),
    ("JPY", "Japanese Yen", "¥", 0),
]


def log(message: str) -> None:
    print(f"[bootstrap] {message}")


def fail(message: str) -> "NoReturn":  # noqa: F821
    print(f"[bootstrap] ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def parse_args() -> argparse.Namespace:
    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=env("DATABASE_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=env("DATABASE_PORT", "5434"))
    parser.add_argument("--database", default=env("DATABASE_NAME", "fintrace"))
    parser.add_argument("--app-role", default=env("DATABASE_USER", "fintrace_app"))
    parser.add_argument("--app-password", default=None, help="password for the runtime role")
    parser.add_argument("--admin-user", default=env("FINTRACE_DB_ADMIN_USER", "postgres"), help="superuser used only by this script")
    parser.add_argument("--admin-database", default=env("FINTRACE_DB_ADMIN_DATABASE", "postgres"))
    parser.add_argument("--seed-currencies", action="store_true", help="add common currencies that are missing")
    parser.add_argument("--admin-email", help="create this user (if missing) as the first sign-in")
    parser.add_argument("--admin-username", help="defaults to the part of --admin-email before @")
    parser.add_argument("--admin-name", default="", help='first and last name, e.g. "Asha Rao"')
    parser.add_argument("--workspace-name", help="create a workspace owned by --admin-email")
    parser.add_argument("--workspace-slug", help="defaults to a slug of --workspace-name")
    parser.add_argument("--workspace-currency", default="USD", help="ISO code of the workspace's base currency")
    parser.add_argument("--workspace-timezone", default="UTC", help="IANA name, e.g. Asia/Kolkata")
    args = parser.parse_args()
    if args.workspace_name and not args.admin_email:
        parser.error("--workspace-name needs --admin-email (a workspace must have an owner)")
    for name in (args.database, args.app_role):
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", name):
            parser.error(f"'{name}' is not a simple lowercase identifier")
    return args


def connect(args, dbname: str, password: str) -> psycopg.Connection:
    try:
        return psycopg.connect(host=args.host, port=args.port, dbname=dbname, user=args.admin_user, password=password, autocommit=True)
    except psycopg.OperationalError as exc:
        fail(
            f"cannot connect to {args.host}:{args.port}/{dbname} as '{args.admin_user}': {str(exc).strip()}\n"
            "            Set FINTRACE_DB_ADMIN_USER / FINTRACE_DB_ADMIN_PASSWORD to a PostgreSQL superuser."
        )


def ensure_role(cursor, name: str, password: str | None) -> None:
    cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", [name])
    exists = cursor.fetchone() is not None
    login = sql.SQL("LOGIN PASSWORD {}").format(sql.Literal(password)) if password else sql.SQL("NOLOGIN")
    verb = sql.SQL("ALTER ROLE") if exists else sql.SQL("CREATE ROLE")
    cursor.execute(sql.SQL("{} {} WITH {} {}").format(verb, sql.Identifier(name), sql.SQL(ROLE_ATTRIBUTES), login))
    log(f"role {name}: {'updated' if exists else 'created'}{'' if password else ' (no login)'}")


def ensure_database(cursor, name: str) -> None:
    cursor.execute("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = %s", [name])
    row = cursor.fetchone()
    if row is None:
        cursor.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(name), sql.Identifier(OWNER_ROLE)))
        log(f"database {name}: created")
    elif row[0] != OWNER_ROLE:
        fail(f"database '{name}' already exists but is owned by '{row[0]}', not '{OWNER_ROLE}'. Refusing to touch it.")
    else:
        log(f"database {name}: already exists")


def run_as_owner(connection: psycopg.Connection, script: str, label: str) -> None:
    """Run a SQL script so that everything it creates belongs to the owner role."""
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(OWNER_ROLE)))
        try:
            cursor.execute(script)
            while cursor.nextset():
                pass
        except psycopg.Error as exc:
            connection.execute("ROLLBACK")
            fail(f"{label} failed: {str(exc).strip()}")
        finally:
            connection.execute("RESET ROLE")
    log(f"{label}: applied")


def ensure_schema(connection: psycopg.Connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'fintrace' AND table_name = 'ledger_entries'")
        has_schema = cursor.fetchone()[0] > 0
    if not has_schema:
        run_as_owner(connection, (ROOT / "schema.sql").read_text(), "schema.sql")
        return
    log("schema: already present; applying patches")
    for patch in sorted((ROOT / "db" / "patches").glob("*.sql")):
        run_as_owner(connection, patch.read_text(), f"patch {patch.name}")


def ensure_django_tables(args, admin_password: str) -> None:
    """Let Django create its own tables, owned by the owner role, in the fintrace schema."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "FinTrace.settings")
    os.environ.setdefault("SECRET_KEY", "bootstrap-only-not-used-to-serve-requests")
    import django
    from django.conf import settings

    django.setup()
    settings.DATABASES["default"].update(
        HOST=args.host, PORT=args.port, NAME=args.database, USER=args.admin_user, PASSWORD=admin_password,
        OPTIONS={"options": f"-c search_path=fintrace,public -c role={OWNER_ROLE}"},
    )
    settings.CACHES["default"] = {"BACKEND": "django.core.cache.backends.db.DatabaseCache", "LOCATION": "django_cache"}
    from django.core.management import call_command
    from django.db import connections

    connections.close_all()
    call_command("migrate", interactive=False, verbosity=0)
    call_command("createcachetable", verbosity=0)
    connections.close_all()
    log("django tables (sessions, auth, content types, cache): ready")


def seed_currencies(connection: psycopg.Connection) -> None:
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(OWNER_ROLE)))
        added = 0
        for code, name, symbol, decimals in CURRENCIES:
            cursor.execute(
                "INSERT INTO fintrace.currencies (code, name, symbol, decimal_places) VALUES (%s, %s, %s, %s) ON CONFLICT (code) DO NOTHING",
                [code, name, symbol, decimals],
            )
            added += cursor.rowcount
        cursor.execute("RESET ROLE")
    log(f"currencies: {added} added, {len(CURRENCIES) - added} already present")


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:80] or "workspace"


def seed_admin(connection: psycopg.Connection, args) -> None:
    from django.contrib.auth.hashers import make_password
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError

    email = args.admin_email.strip().lower()
    username = args.admin_username or email.split("@", 1)[0]
    first, _, last = args.admin_name.strip().partition(" ")
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(OWNER_ROLE)))
        cursor.execute("SELECT id FROM fintrace.users WHERE lower(email) = %s", [email])
        row = cursor.fetchone()
        if row:
            user_id = row[0]
            log(f"user {email}: already exists (password left unchanged)")
        else:
            password = os.environ.get("FINTRACE_ADMIN_PASSWORD") or getpass.getpass(f"Password for {email}: ")
            try:
                validate_password(password)
            except ValidationError as exc:
                fail("that password is not acceptable: " + " ".join(exc.messages))
            cursor.execute(
                "INSERT INTO fintrace.users (username, email, password_hash, first_name, last_name) VALUES (%s, %s, %s, %s, %s) RETURNING id",
                [username, email, make_password(password), first, last],
            )
            user_id = cursor.fetchone()[0]
            log(f"user {email}: created (username '{username}')")

        if args.workspace_name:
            slug = args.workspace_slug or slugify(args.workspace_name)
            cursor.execute("SELECT 1 FROM fintrace.tenants WHERE slug = %s", [slug])
            if cursor.fetchone():
                log(f"workspace '{slug}': already exists")
            else:
                cursor.execute("SELECT id FROM fintrace.currencies WHERE code = %s AND is_active", [args.workspace_currency.upper()])
                currency = cursor.fetchone()
                if currency is None:
                    fail(f"currency {args.workspace_currency} does not exist. Add --seed-currencies or insert it first.")
                cursor.execute("SELECT fintrace.provision_tenant(%s, %s, %s, %s)", [user_id, slug, args.workspace_name, currency[0]])
                tenant_id = cursor.fetchone()[0]
                if args.workspace_timezone != "UTC":
                    # Tenant rows are audited, and the audit trail needs an actor.
                    cursor.execute("BEGIN")
                    cursor.execute("SELECT fintrace.set_context(%s, %s)", [user_id, tenant_id])
                    cursor.execute("UPDATE fintrace.tenants SET timezone = %s WHERE id = %s", [args.workspace_timezone, tenant_id])
                    cursor.execute("COMMIT")
                log(f"workspace '{args.workspace_name}' ({slug}, {args.workspace_currency.upper()}, {args.workspace_timezone}): created, owned by {email}")
        cursor.execute("RESET ROLE")


def verify(args, app_password: str) -> None:
    try:
        with psycopg.connect(host=args.host, port=args.port, dbname=args.database, user=args.app_role, password=app_password) as connection:
            row = connection.execute(
                """
                SELECT r.rolsuper, r.rolbypassrls,
                       has_table_privilege(current_user, 'fintrace.ledger_entries', 'SELECT'),
                       has_table_privilege(current_user, 'fintrace.django_session', 'INSERT'),
                       has_table_privilege(current_user, 'fintrace.security_config', 'SELECT'),
                       (SELECT count(*) FROM fintrace.currencies)
                  FROM pg_roles r WHERE r.rolname = current_user
                """
            ).fetchone()
    except psycopg.OperationalError as exc:
        fail(f"the runtime role '{args.app_role}' cannot connect: {str(exc).strip()}")
    superuser, bypass_rls, can_read_ledger, can_write_sessions, can_read_secret, currencies = row
    problems = []
    if superuser or bypass_rls:
        problems.append("the runtime role is a superuser or can bypass row-level security")
    if not can_read_ledger or not can_write_sessions:
        problems.append("the runtime role is missing table privileges")
    if can_read_secret:
        problems.append("the runtime role can read the context-signing secret")
    if problems:
        fail("verification failed: " + "; ".join(problems))
    log(f"verified: '{args.app_role}' connects, is not privileged, and has the expected grants")
    if currencies == 0:
        log("note: there are no currencies yet. Re-run with --seed-currencies before creating a workspace.")


def main() -> None:
    args = parse_args()
    app_password = args.app_password or os.environ.get("DATABASE_PASSWORD")
    if (not app_password or app_password == "change-me") and dotenv_values:
        env_dict = dotenv_values(ROOT / ".env")
        val = env_dict.get("DATABASE_PASSWORD")
        if val and val != "change-me":
            app_password = val
            os.environ["DATABASE_PASSWORD"] = val
    if not app_password or app_password == "change-me":
        fail("set DATABASE_PASSWORD (in the environment or .env) to the password the runtime role should have.")
    admin_password = os.environ.get("FINTRACE_DB_ADMIN_PASSWORD")
    if admin_password is None:
        admin_password = getpass.getpass(f"Password for PostgreSQL superuser '{args.admin_user}': ")

    log(f"target: {args.host}:{args.port}/{args.database}")
    with connect(args, args.admin_database, admin_password) as server:
        with server.cursor() as cursor:
            cursor.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
            if not cursor.fetchone()[0]:
                fail(f"'{args.admin_user}' is not a superuser; it cannot create roles and assume the owner role.")
            ensure_role(cursor, OWNER_ROLE, None)
            ensure_role(cursor, args.app_role, app_password)
            ensure_role(cursor, WORKER_ROLE, os.environ.get("FINTRACE_WORKER_PASSWORD"))
            ensure_role(cursor, AUDITOR_ROLE, os.environ.get("FINTRACE_AUDITOR_PASSWORD"))
            ensure_database(cursor, args.database)

    with connect(args, args.database, admin_password) as database:
        ensure_schema(database)
        ensure_django_tables(args, admin_password)
        grants = (ROOT / "grant_permissions.sql").read_text()
        if args.app_role != "fintrace_app":
            grants = re.sub(r"\bfintrace_app\b", args.app_role, grants)
        with database.cursor() as cursor:
            cursor.execute(grants)
        log("runtime grants: applied")
        if args.seed_currencies:
            seed_currencies(database)
        if args.admin_email:
            seed_admin(database, args)

    verify(args, app_password)
    log("done.")


if __name__ == "__main__":
    main()
