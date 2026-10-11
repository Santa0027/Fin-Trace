from uuid import UUID

from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor

_PUBLIC_COLUMNS = "id, provider, status, broker_user_id, broker_user_name, token_expires_at, connected_at, last_synced_at, last_error, cash_available"


class BrokerRepository:
    def __init__(self) -> None:
        self.db = DatabaseExecutor()

    def connection(self, provider: str, *, with_token: bool = False, for_update: bool = False) -> dict | None:
        columns = _PUBLIC_COLUMNS + (", access_token_encrypted" if with_token else "")
        return self.db.fetch_one(
            f"SELECT {columns} FROM fintrace.broker_connections WHERE tenant_id = fintrace.current_tenant_id() AND provider = %s"
            + (" FOR UPDATE" if for_update else ""),
            [provider],
        )

    def save_connection(self, tenant_id: UUID, user_id: UUID, provider: str, status: str, broker_user_id: str, broker_user_name: str, token: str | None, expires_at) -> UUID:
        return self.db.execute_returning_id(
            """
            INSERT INTO fintrace.broker_connections
                (tenant_id, provider, status, broker_user_id, broker_user_name, access_token_encrypted, token_expires_at, connected_by, connected_at, last_error)
            VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s::uuid, clock_timestamp(), '')
            ON CONFLICT (tenant_id, provider) DO UPDATE
               SET status = EXCLUDED.status, broker_user_id = EXCLUDED.broker_user_id, broker_user_name = EXCLUDED.broker_user_name,
                   access_token_encrypted = EXCLUDED.access_token_encrypted, token_expires_at = EXCLUDED.token_expires_at,
                   connected_by = EXCLUDED.connected_by, connected_at = clock_timestamp(), last_error = ''
            RETURNING id
            """,
            [str(tenant_id), provider, status, broker_user_id, broker_user_name, token, expires_at, str(user_id)],
        )

    def set_status(self, connection_id: UUID, status: str, error: str = "") -> None:
        """Any status other than CONNECTED also forgets the token."""
        self.db.execute(
            """
            UPDATE fintrace.broker_connections
               SET status = %s, last_error = %s,
                   access_token_encrypted = CASE WHEN %s = 'CONNECTED' THEN access_token_encrypted END,
                   token_expires_at = CASE WHEN %s = 'CONNECTED' THEN token_expires_at END
             WHERE id = %s::uuid
            """,
            [status, error[:500], status, status, str(connection_id)],
        )

    def replace_holdings(self, tenant_id: UUID, connection_id: UUID, rows: list[dict], snapshot_date) -> None:
        self.db.execute("DELETE FROM fintrace.broker_holdings WHERE connection_id = %s::uuid", [str(connection_id)])
        for row in rows:
            self.db.execute(
                """
                INSERT INTO fintrace.broker_holdings
                    (tenant_id, connection_id, asset_class, symbol, name, exchange, isin, folio, quantity, average_price,
                     last_price, close_price, invested_value, current_value, pnl, day_change)
                VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [str(tenant_id), str(connection_id), row["asset_class"], row["symbol"], row["name"], row["exchange"], row["isin"], row["folio"],
                 row["quantity"], row["average_price"], row["last_price"], row["close_price"], row["invested_value"], row["current_value"], row["pnl"], row["day_change"]],
            )
        self.save_snapshot(tenant_id, connection_id, snapshot_date, rows)
        self.save_holding_snapshots(tenant_id, connection_id, snapshot_date, rows)
        self.db.execute("UPDATE fintrace.broker_connections SET last_synced_at = clock_timestamp(), last_error = '' WHERE id = %s::uuid", [str(connection_id)])

    def save_holding_snapshots(self, tenant_id: UUID, connection_id: UUID, snapshot_date, rows: list[dict]) -> None:
        self.db.execute("DELETE FROM fintrace.broker_holding_snapshots WHERE connection_id = %s::uuid AND snapshot_date = %s", [str(connection_id), snapshot_date])
        merged: dict[tuple, list] = {}
        for row in rows:  # the same fund can appear twice under one folio; keep one row per key
            key = (row["asset_class"], row["symbol"], row["folio"])
            totals = merged.setdefault(key, [0, 0, 0])
            totals[0] += row["quantity"]
            totals[1] += row["invested_value"]
            totals[2] += row["current_value"]
        for (asset_class, symbol, folio), (quantity, invested, current) in merged.items():
            self.db.execute(
                """
                INSERT INTO fintrace.broker_holding_snapshots
                    (tenant_id, connection_id, snapshot_date, asset_class, symbol, folio, quantity, invested_value, current_value)
                VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s)
                """,
                [str(tenant_id), str(connection_id), snapshot_date, asset_class, symbol, folio, quantity, invested, current],
            )

    def replace_extras(self, tenant_id: UUID, connection_id: UUID, cash, positions: list[dict] | None, sips: list[dict] | None, note: str = "") -> None:
        """Cash, open positions and SIPs. ``None`` means "could not be fetched": keep what was there."""
        if cash is not None:
            self.db.execute("UPDATE fintrace.broker_connections SET cash_available = %s WHERE id = %s::uuid", [cash, str(connection_id)])
        if positions is not None:
            self.db.execute("DELETE FROM fintrace.broker_positions WHERE connection_id = %s::uuid", [str(connection_id)])
            for row in positions:
                self.db.execute(
                    "INSERT INTO fintrace.broker_positions (tenant_id, connection_id, symbol, exchange, product, quantity, average_price, last_price, pnl) VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s)",
                    [str(tenant_id), str(connection_id), row["symbol"], row["exchange"], row["product"], row["quantity"], row["average_price"], row["last_price"], row["pnl"]],
                )
        if sips is not None:
            self.db.execute("DELETE FROM fintrace.broker_sips WHERE connection_id = %s::uuid", [str(connection_id)])
            for row in sips:
                self.db.execute(
                    """
                    INSERT INTO fintrace.broker_sips (tenant_id, connection_id, sip_id, fund, symbol, status, frequency, instalment_amount,
                                                      instalment_day, next_instalment, completed_instalments, pending_instalments)
                    VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [str(tenant_id), str(connection_id), row["sip_id"], row["fund"], row["symbol"], row["status"], row["frequency"], row["instalment_amount"],
                     row["instalment_day"], row["next_instalment"], row["completed_instalments"], row["pending_instalments"]],
                )
        if note:
            self.db.execute("UPDATE fintrace.broker_connections SET last_error = %s WHERE id = %s::uuid", [note[:500], str(connection_id)])

    def positions(self, connection_id: UUID) -> list[dict]:
        return self.db.fetch_all(
            "SELECT symbol, exchange, product, quantity, average_price, last_price, pnl FROM fintrace.broker_positions WHERE connection_id = %s::uuid ORDER BY symbol",
            [str(connection_id)],
        )

    def sips(self, connection_id: UUID) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT sip_id, fund, symbol, status, frequency, instalment_amount, instalment_day, next_instalment, completed_instalments, pending_instalments
              FROM fintrace.broker_sips WHERE connection_id = %s::uuid
             ORDER BY (status = 'ACTIVE') DESC, next_instalment NULLS LAST, fund
            """,
            [str(connection_id)],
        )

    def holding_values_on_or_before(self, connection_id: UUID, day) -> tuple[object, dict]:
        """Each holding's value on the latest synced day that is not after ``day``."""
        row = self.db.fetch_one(
            "SELECT max(snapshot_date) AS day FROM fintrace.broker_holding_snapshots WHERE connection_id = %s::uuid AND snapshot_date <= %s",
            [str(connection_id), day],
        )
        if not row or row["day"] is None:
            return None, {}
        rows = self.db.fetch_all(
            "SELECT asset_class, symbol, folio, invested_value, current_value FROM fintrace.broker_holding_snapshots WHERE connection_id = %s::uuid AND snapshot_date = %s",
            [str(connection_id), row["day"]],
        )
        return row["day"], {(r["asset_class"], r["symbol"], r["folio"]): r for r in rows}

    def save_snapshot(self, tenant_id: UUID, connection_id: UUID, snapshot_date, rows: list[dict]) -> None:
        def total(field: str, asset_class: str | None = None):
            return sum((row[field] for row in rows if asset_class in (None, row["asset_class"])), 0)

        self.db.execute(
            """
            INSERT INTO fintrace.broker_portfolio_snapshots
                (tenant_id, connection_id, snapshot_date, invested_value, current_value, equity_value, mutual_fund_value, holding_count)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, connection_id, snapshot_date) DO UPDATE
               SET invested_value = EXCLUDED.invested_value, current_value = EXCLUDED.current_value, equity_value = EXCLUDED.equity_value,
                   mutual_fund_value = EXCLUDED.mutual_fund_value, holding_count = EXCLUDED.holding_count
            """,
            [str(tenant_id), str(connection_id), snapshot_date, total("invested_value"), total("current_value"),
             total("current_value", "EQUITY"), total("current_value", "MUTUAL_FUND"), len(rows)],
        )

    def holdings(self, connection_id: UUID) -> list[dict]:
        return self.db.fetch_all(
            """
            SELECT id, asset_class, symbol, name, exchange, isin, folio, quantity, average_price, last_price, close_price,
                   invested_value, current_value, pnl, day_change, synced_at
              FROM fintrace.broker_holdings
             WHERE connection_id = %s::uuid
             ORDER BY current_value DESC, symbol
            """,
            [str(connection_id)],
        )

    def history(self, connection_id: UUID, limit: int = 180) -> list[dict]:
        rows = self.db.fetch_all(
            """
            SELECT snapshot_date, invested_value, current_value, equity_value, mutual_fund_value
              FROM fintrace.broker_portfolio_snapshots
             WHERE connection_id = %s::uuid
             ORDER BY snapshot_date DESC LIMIT %s
            """,
            [str(connection_id), limit],
        )
        return list(reversed(rows))
