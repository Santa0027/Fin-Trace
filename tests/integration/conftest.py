import os
import pytest
from uuid import uuid4
import psycopg
from django.conf import settings

@pytest.fixture(scope="session", autouse=True)
def protect_database():
    db_name = settings.DATABASES["default"]["NAME"].lower()
    if "integration" not in db_name and "test" not in db_name:
        pytest.exit(f"ABORT: Running integration tests against '{db_name}' is forbidden.")

@pytest.fixture(scope="session", autouse=True)
def never_flush_database():
    """Transactional Django tests TRUNCATE every managed table on teardown.

    This suite runs against a persistent database as the unprivileged runtime
    role, which rightly cannot truncate anything. Tests create uniquely named
    data instead of relying on a flush.
    """
    from django.test import TransactionTestCase

    original = TransactionTestCase._fixture_teardown
    TransactionTestCase._fixture_teardown = lambda self: None
    yield
    TransactionTestCase._fixture_teardown = original


@pytest.fixture(scope="session")
def django_db_setup(django_db_blocker):
    settings.DATABASES["default"]["NAME"] = os.environ.get("DATABASE_NAME", "fintrace_integration")
    settings.DATABASES["default"]["USER"] = os.environ.get("DATABASE_USER", "fintrace_app")
    settings.DATABASES["default"]["PASSWORD"] = os.environ.get("DATABASE_PASSWORD", "")
    settings.DATABASES["default"]["HOST"] = os.environ.get("DATABASE_HOST", "127.0.0.1")
    settings.DATABASES["default"]["PORT"] = os.environ.get("DATABASE_PORT", "5434")

@pytest.fixture(scope="session")
def setup_db(django_db_setup, django_db_blocker):
    # Separate privileged connection for base fixture idempotency ONLY
    admin_user = os.environ.get("FINTRACE_TEST_ADMIN_USER", "fintrace_user")
    admin_password = os.environ.get("FINTRACE_TEST_ADMIN_PASSWORD", "fintrace_password")
    db_host = os.environ.get("DATABASE_HOST", "127.0.0.1")
    db_port = os.environ.get("DATABASE_PORT", "5434")
    db_name = os.environ.get("DATABASE_NAME", "fintrace_integration")
    conn_str = f"host={db_host} port={db_port} dbname={db_name} user={admin_user} password={admin_password}"
    
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cursor:
            # We execute commands as fintrace_owner since that role owns objects
            # but has NOLOGIN. We login as superuser and SET ROLE.
            cursor.execute("SET ROLE fintrace_owner;")
            
            cursor.execute("""
                INSERT INTO fintrace.currencies (id, code, name, symbol, decimal_places)
                VALUES ('d5b3d9d3-5a02-42c2-843c-62ea6b6b7f3b'::uuid, 'USD', 'US Dollar', '$', 2)
                ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id;
            """)
            usd_id = cursor.fetchone()[0]
            
            # User A
            cursor.execute("SELECT id FROM fintrace.users WHERE username = 'user_a'")
            row = cursor.fetchone()
            if row:
                user_a_id = row[0]
            else:
                user_a_id = uuid4()
                cursor.execute("INSERT INTO fintrace.users (id, username, email, password_hash, first_name) VALUES (%s, 'user_a', 'user_a@test.com', 'dummy', 'User A')", [user_a_id])
                
            # User B
            cursor.execute("SELECT id FROM fintrace.users WHERE username = 'user_b'")
            row = cursor.fetchone()
            if row:
                user_b_id = row[0]
            else:
                user_b_id = uuid4()
                cursor.execute("INSERT INTO fintrace.users (id, username, email, password_hash, first_name) VALUES (%s, 'user_b', 'user_b@test.com', 'dummy', 'User B')", [user_b_id])
            
            # Tenant A
            cursor.execute("SELECT id FROM fintrace.tenants WHERE slug = 'integration-tenant-a'")
            row = cursor.fetchone()
            if row:
                tenant_a_id = row[0]
            else:
                cursor.execute("SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)", [user_a_id, 'integration-tenant-a', 'Tenant A', usd_id])
                tenant_a_id = cursor.fetchone()[0]

            # Tenant B
            cursor.execute("SELECT id FROM fintrace.tenants WHERE slug = 'integration-tenant-b'")
            row = cursor.fetchone()
            if row:
                tenant_b_id = row[0]
            else:
                cursor.execute("SELECT fintrace.provision_tenant(%s::uuid, %s, %s, %s::uuid)", [user_b_id, 'integration-tenant-b', 'Tenant B', usd_id])
                tenant_b_id = cursor.fetchone()[0]
                
            conn.commit()

            yield {
                "currency_id": usd_id,
                "user_a_id": user_a_id,
                "user_b_id": user_b_id,
                "tenant_a_id": tenant_a_id,
                "tenant_b_id": tenant_b_id
            }
            # privileged connection is closed here.

@pytest.fixture
def context(setup_db):
    return setup_db


@pytest.fixture
def admin_connection():
    admin_user = os.environ.get("FINTRACE_TEST_ADMIN_USER", "fintrace_user")
    admin_password = os.environ.get("FINTRACE_TEST_ADMIN_PASSWORD", "fintrace_password")
    db_host = os.environ.get("DATABASE_HOST", "127.0.0.1")
    db_port = os.environ.get("DATABASE_PORT", "5434")
    db_name = os.environ.get("DATABASE_NAME", "fintrace_integration")
    conn_str = f"host={db_host} port={db_port} dbname={db_name} user={admin_user} password={admin_password}"

    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cursor:
            cursor.execute("SET ROLE fintrace_owner;")
        yield conn
