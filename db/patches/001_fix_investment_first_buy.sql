-- Patch for databases bootstrapped before this fix was folded into schema.sql.
-- Run as the schema owner (fintrace_owner). Safe to run more than once.
--
-- apply_investment_trade_to_position() read the current position with
-- SELECT ... INTO, which sets its targets to NULL when no row matches. The first
-- trade in any instrument therefore tried to write a NULL quantity and was
-- rejected, so no investment could ever be bought.

BEGIN;

CREATE OR REPLACE FUNCTION fintrace.apply_investment_trade_to_position()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fintrace, pg_temp
AS $$
DECLARE
    v_quantity NUMERIC(24,8) := 0;
    v_average_cost NUMERIC(28,8) := 0;
BEGIN
    PERFORM 1 FROM fintrace.investment_portfolios
     WHERE tenant_id = NEW.tenant_id AND id = NEW.portfolio_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Investment portfolio not found for tenant' USING ERRCODE = '23503';
    END IF;

    SELECT quantity, average_cost
      INTO v_quantity, v_average_cost
      FROM fintrace.investment_positions
     WHERE tenant_id = NEW.tenant_id
       AND portfolio_id = NEW.portfolio_id
       AND instrument_id = NEW.instrument_id
     FOR UPDATE;

    -- SELECT INTO nulls its targets when no row matches; a first trade in an
    -- instrument starts from an empty position, not an unknown one.
    IF NOT FOUND THEN
        v_quantity := 0;
        v_average_cost := 0;
    END IF;

    IF NEW.trade_type = 'BUY' THEN
        IF v_quantity = 0 THEN
            v_average_cost := round(((NEW.quantity * NEW.price) + NEW.fees) / NEW.quantity, 8);
        ELSE
            v_average_cost := round((v_quantity * v_average_cost + NEW.quantity * NEW.price + NEW.fees)
                                    / (v_quantity + NEW.quantity), 8);
        END IF;
        v_quantity := v_quantity + NEW.quantity;
        NEW.realized_pnl := 0;
    ELSE
        IF v_quantity < NEW.quantity THEN
            RAISE EXCEPTION 'Cannot sell % units when only % are available', NEW.quantity, v_quantity
                USING ERRCODE = '23514';
        END IF;
        NEW.realized_pnl := round((NEW.price - v_average_cost) * NEW.quantity - NEW.fees, 8);
        v_quantity := v_quantity - NEW.quantity;
        IF v_quantity = 0 THEN
            v_average_cost := 0;
        END IF;
    END IF;

    INSERT INTO fintrace.investment_positions (
        tenant_id, portfolio_id, instrument_id, quantity, average_cost
    ) VALUES (
        NEW.tenant_id, NEW.portfolio_id, NEW.instrument_id, v_quantity, v_average_cost
    )
    ON CONFLICT (tenant_id, portfolio_id, instrument_id)
    DO UPDATE SET quantity = EXCLUDED.quantity,
                  average_cost = EXCLUDED.average_cost,
                  updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

COMMIT;
