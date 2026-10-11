#!/usr/bin/env python
"""Seed demo users and realistic demo data for every FinTrace module.

Everything is created through the same application flows the API uses, as the
unprivileged runtime role, so the demo ledger is balanced, audited and subject
to row-level security exactly like real data. No superuser is needed.

What you get:
  * Three sign-ins with different access: an owner, a member and a viewer.
  * "Demo Household": six months of income, expenses, transfers (including one
    between currencies), a credit card, a reversed entry, loans with repayments,
    investments (buys, a sale, dividends), recurring items (some due now),
    savings goals, physical assets with valuations, subscriptions, tags and contacts,
    and a sample Zerodha portfolio (clearly labelled as sample data).
  * "Demo Side Business": a second, smaller workspace, to try workspace switching.

Usage:

    python scripts/seed_demo.py                     # prompts nothing, prints the sign-ins
    python scripts/seed_demo.py --currency INR --timezone Asia/Kolkata
    python scripts/seed_demo.py --suffix team2      # a second, separate demo set

Amounts are the same figures whatever currency you choose (a 5,200 salary is
5,200 dollars or 5,200 rupees); pick the currency for how the screens should read.

Run scripts/bootstrap_db.py --seed-currencies first. FinTrace never deletes
financial records, so a demo set cannot be removed afterwards: seed a scratch
database, not production (the script refuses when ENV=production unless told otherwise).

The password for all three demo users comes from --password or
FINTRACE_DEMO_PASSWORD; otherwise one is generated and printed once.
"""
import argparse
import os
import random
import secrets
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "FinTrace.settings")

import django  # noqa: E402

django.setup()

from django.contrib.auth.hashers import make_password  # noqa: E402
from django.contrib.auth.password_validation import validate_password  # noqa: E402
from django.core.exceptions import ValidationError  # noqa: E402
from django.db import DatabaseError, connection, transaction  # noqa: E402

from FinTrace.apps.core.application.dto import TenantContextDTO  # noqa: E402
from FinTrace.apps.core.application.flows import FinancialFlows  # noqa: E402
from FinTrace.apps.core.application.parsing import business_datetime, local_today  # noqa: E402
from FinTrace.apps.core.application.services import AssetService, GoalService, ResourceService, TagService, TenantAwareService  # noqa: E402
from FinTrace.apps.core.domain.exceptions import ApiError  # noqa: E402
from FinTrace.apps.core.application.broker import PROVIDER as BROKER, normalise_holdings, normalise_positions, normalise_sips  # noqa: E402
from FinTrace.apps.core.infrastructure.broker_repository import BrokerRepository  # noqa: E402
from FinTrace.apps.core.infrastructure.flow_repository import FlowRepository  # noqa: E402
from FinTrace.apps.core.infrastructure.read_models import NORMAL_BALANCE_BY_TYPE, FinancialReadRepository  # noqa: E402
from FinTrace.apps.core.infrastructure.repositories import HistoryRepository, PostgreSQLLedgerRepository, TagAssociationRepository, TenantResourceRepository  # noqa: E402


def log(message: str) -> None:
    print(f"[demo] {message}")


def fail(message: str) -> "NoReturn":  # noqa: F821
    print(f"[demo] ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def month_start(today: date, months_back: int) -> date:
    year, month = today.year, today.month - months_back
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


class Workspace:
    """One demo workspace, driven through the application flows as its owner."""

    def __init__(self, user_id, tenant_id, currency_id, timezone: str, decimals: int = 2) -> None:
        self.decimals = decimals
        self.ctx = TenantContextDTO(user_id=user_id, tenant_id=tenant_id)
        self.currency_id = str(currency_id)
        self.timezone = timezone
        self.flows = FinancialFlows()
        self.today = local_today(timezone)
        self.service = TenantAwareService()
        self.counts: dict[str, int] = {}

    def tx(self):
        return self.service._tx(self.ctx)

    def count(self, what: str, n: int = 1) -> None:
        self.counts[what] = self.counts.get(what, 0) + n

    def m(self, amount) -> str:
        """An amount in the workspace currency, rounded to what that currency allows (yen have no cents)."""
        return format(Decimal(str(amount)).quantize(Decimal(1).scaleb(-self.decimals)), "f")

    def past(self, day: date) -> bool:
        return day <= self.today

    # -- reference data ----------------------------------------------------
    def create(self, resource: str, payload: dict):
        row_id = ResourceService(TenantResourceRepository(resource)).create(self.ctx, payload)
        self.count(resource)
        return str(row_id)

    def account(self, name: str, account_type: str, *, opening: str | None = None, opened_on: date | None = None,
                institution: str = "", currency_id: str | None = None, number: str = "") -> str:
        account_id = self.create("accounts", {
            "name": name, "type": account_type, "normal_balance": NORMAL_BALANCE_BY_TYPE[account_type],
            "currency_id": currency_id or self.currency_id, "institution": institution, "account_number": number,
        })
        if opening:
            with self.tx():
                self.flows.opening_balance(self.ctx, account_id, Decimal(self.m(opening)), opened_on or self.today, {})
        return account_id

    def category(self, name: str, kind: str) -> str:
        return self.create("categories", {"name": name, "type": kind})

    def contact(self, name: str, email: str | None = None) -> str:
        return self.create("contacts", {"name": name, "email": email})

    # -- money -------------------------------------------------------------
    def income(self, day: date, amount, category: str, account: str, notes: str, contact: str | None = None) -> dict | None:
        if not self.past(day):
            return None
        with self.tx():
            body, _ = self.flows.record_income(self.ctx, {"amount": self.m(amount), "category_id": category, "destination_account_id": account,
                                                         "occurred_on": day.isoformat(), "notes": notes, "contact_id": contact})
        self.count("income")
        return body

    def expense(self, day: date, amount, category: str, account: str, notes: str, contact: str | None = None, reference: str = "") -> dict | None:
        if not self.past(day):
            return None
        with self.tx():
            body, _ = self.flows.record_expense(self.ctx, {"amount": self.m(amount), "category_id": category, "source_account_id": account,
                                                          "occurred_on": day.isoformat(), "notes": notes, "contact_id": contact, "reference": reference})
        self.count("expenses")
        return body

    def transfer(self, day: date, amount, source: str, destination: str, description: str, **extra) -> dict | None:
        if not self.past(day):
            return None
        with self.tx():
            body, _ = self.flows.transfer(self.ctx, {"amount": self.m(amount), "from_account_id": source, "to_account_id": destination,
                                                    "occurred_on": day.isoformat(), "description": description, **{k: str(v) for k, v in extra.items()}})
        self.count("transfers")
        return body


# Roughly what one euro costs in each currency; only used to make the demo trip plausible.
EUR_IN = {"USD": Decimal("1.10"), "GBP": Decimal("0.86"), "INR": Decimal("92.50"), "CAD": Decimal("1.50"), "AUD": Decimal("1.65"),
          "SGD": Decimal("1.45"), "AED": Decimal("4.04"), "CHF": Decimal("0.95"), "JPY": Decimal("162")}


def seed_household(ws: Workspace, eur_id: str | None, members: list[dict], base_code: str = "USD") -> None:
    rng = random.Random(42)  # the same demo every time
    today = ws.today
    start = month_start(today, 5)

    # Accounts
    bank = ws.account("Everyday Checking", "BANK", opening="4200.00", opened_on=start, institution="First National Bank", number="****4821")
    savings = ws.account("Rainy Day Savings", "BANK", opening="12500.00", opened_on=start, institution="First National Bank", number="****9034")
    cash = ws.account("Cash", "CASH", opening="180.00", opened_on=start)
    wallet = ws.account("Mobile Wallet", "WALLET", institution="PayNow")
    card = ws.account("Rewards Credit Card", "CREDIT_CARD", opening="640.00", opened_on=start, institution="Summit Card Services", number="****7716")
    broker = ws.account("Brokerage Cash", "BROKER", institution="Northwind Invest")
    travel = ws.account("Travel Wallet (EUR)", "WALLET", institution="Globetrot", currency_id=eur_id) if eur_id and eur_id != ws.currency_id else None

    # Categories
    cat = {name: ws.category(name, kind) for name, kind in [
        ("Salary", "INCOME"), ("Freelance", "INCOME"), ("Interest", "INCOME"), ("Gifts received", "INCOME"),
        ("Rent", "EXPENSE"), ("Groceries", "EXPENSE"), ("Dining out", "EXPENSE"), ("Transport", "EXPENSE"),
        ("Utilities", "EXPENSE"), ("Subscriptions", "EXPENSE"), ("Health", "EXPENSE"), ("Shopping", "EXPENSE"),
        ("Travel", "EXPENSE"), ("Insurance", "EXPENSE"), ("Education", "EXPENSE"),
    ]}
    archived = ws.category("Old gym membership", "EXPENSE")
    with ws.tx():
        ResourceService(TenantResourceRepository("categories")).archive(ws.ctx, archived)

    # Contacts
    employer = ws.contact("Brightline Studios (employer)", "payroll@brightline.example")
    landlord = ws.contact("Maple Court Apartments", "office@maplecourt.example")
    client = ws.contact("Orchard & Co. (client)", "accounts@orchard.example")
    grocer = ws.contact("Fresh Basket Market")
    power = ws.contact("City Power & Water")
    friend = ws.contact("Sam Okafor")

    # Tags
    tags = {name: ws.create("tags", {"name": name, "color": color}) for name, color in
            [("tax-deductible", "#0F7766"), ("reimbursable", "#4B88BD"), ("family", "#DF7668")]}

    # Six months of everyday activity
    dining_places = ["Noodle House", "Corner Bistro", "Taqueria Luna", "Sushi Counter", "Cafe Aroma"]
    tagged: list[tuple[str, str]] = []
    for back in range(5, -1, -1):
        first = month_start(today, back)
        label = first.strftime("%B")
        ws.income(first + timedelta(days=0), "5200.00", cat["Salary"], bank, f"{label} salary", employer)
        ws.expense(first + timedelta(days=1), "1450.00", cat["Rent"], bank, f"{label} rent", landlord, f"RENT-{first:%Y%m}")
        ws.expense(first + timedelta(days=4), Decimal(rng.randrange(8200, 13900)) / 100, cat["Utilities"], bank, "Electricity and water", power)
        ws.expense(first + timedelta(days=6), "64.99", cat["Utilities"], card, "Home internet")
        ws.expense(first + timedelta(days=9), "118.00", cat["Insurance"], bank, "Renter's and health insurance")
        for week in range(4):
            ws.expense(first + timedelta(days=2 + week * 7), Decimal(rng.randrange(6400, 12800)) / 100, cat["Groceries"], card if week % 2 else bank, "Weekly groceries", grocer)
        for n in range(rng.randrange(3, 6)):
            ws.expense(first + timedelta(days=rng.randrange(2, 27)), Decimal(rng.randrange(1400, 6800)) / 100, cat["Dining out"], rng.choice([card, cash, wallet]), rng.choice(dining_places))
        for n in range(rng.randrange(4, 8)):
            ws.expense(first + timedelta(days=rng.randrange(1, 27)), Decimal(rng.randrange(250, 2400)) / 100, cat["Transport"], rng.choice([wallet, card]), rng.choice(["Metro top-up", "Ride share", "Fuel", "Parking"]))
        for name, amount in [("Music streaming", "10.99"), ("Video streaming", "15.49"), ("Cloud storage", "2.99")]:
            ws.expense(first + timedelta(days=11), amount, cat["Subscriptions"], card, name)
        if back % 2 == 0:
            ws.expense(first + timedelta(days=14), Decimal(rng.randrange(3500, 21000)) / 100, cat["Shopping"], card, rng.choice(["Running shoes", "Kitchen bits", "Winter jacket", "Books"]))
        if back in (4, 1):
            ws.income(first + timedelta(days=17), Decimal(rng.randrange(60000, 140000)) / 100, cat["Freelance"], bank, "Brand design project", client)
        if back == 3:
            row = ws.expense(first + timedelta(days=19), "240.00", cat["Education"], bank, "Online design course")
            row and tagged.append((row["id"], tags["tax-deductible"]))
            ws.expense(first + timedelta(days=21), "85.00", cat["Health"], bank, "Dental check-up")
        ws.income(first + timedelta(days=27), Decimal(rng.randrange(900, 1900)) / 100, cat["Interest"], savings, "Savings interest")
        # Moving money around: none of this is income or spending.
        ws.transfer(first + timedelta(days=2), "600.00", bank, savings, "Monthly savings")
        ws.transfer(first + timedelta(days=3), "150.00", bank, wallet, "Wallet top-up")
        ws.transfer(first + timedelta(days=3), "100.00", bank, cash, "Cash withdrawal")
        ws.transfer(first + timedelta(days=20), Decimal(rng.randrange(26000, 34000)) / 100, bank, card, "Credit card payment")
    ws.income(month_start(today, 2) + timedelta(days=12), "150.00", cat["Gifts received"], bank, "Birthday gift")

    # A work trip: paid personally, tagged as reimbursable, partly in another currency.
    trip = month_start(today, 2) + timedelta(days=8)
    row = ws.expense(trip, "412.60", cat["Travel"], card, "Flights for client workshop", client)
    row and tagged.append((row["id"], tags["reimbursable"]))
    if travel:
        # 330 of the workspace currency exchanged into euros at roughly the going rate, then partly spent.
        rate = EUR_IN.get(base_code, Decimal("1.10"))
        euros = (Decimal("330") / rate).quantize(Decimal("0.01"))
        ws.transfer(trip, "330.00", bank, travel, "Trip spending money", to_amount=euros)
        for offset, share, what in [(1, "0.29", "Hotel city tax and breakfast"), (2, "0.14", "Museum and tram pass"), (2, "0.20", "Dinner with client")]:
            day = trip + timedelta(days=offset)
            if ws.past(day):
                with ws.tx():
                    ws.flows.record_expense(ws.ctx, {"amount": str((euros * Decimal(share)).quantize(Decimal("0.01"))), "category_id": cat["Travel"],
                                                    "source_account_id": travel, "occurred_on": day.isoformat(), "notes": what, "exchange_rate": str(rate)})
                ws.count("expenses")

    with ws.tx():
        tagger = TagService(TagAssociationRepository())
        for expense_id, tag_id in tagged:
            tagger.add_expense_tag(ws.ctx, expense_id, tag_id)
    ws.count("tagged expenses", len(tagged))

    # A mistake, corrected the right way: reversed, then entered again.
    oops_day = month_start(today, 0) + timedelta(days=1)
    oops = ws.expense(oops_day, "920.00", cat["Groceries"], bank, "Groceries (entered with the wrong amount)")
    if oops:
        with ws.tx():
            ws.flows.reverse(ws.ctx, oops["ledger_transaction_id"], {"reference": "Typed 920 instead of 92"})
        ws.count("reversals")
        ws.expense(oops_day, "92.00", cat["Groceries"], bank, "Groceries (corrected)")

    # Loans
    with ws.tx():
        car, _ = ws.flows.create_debt(ws.ctx, {"type": "PAYABLE", "contact_name": "Harbor Auto Finance", "principal_amount": ws.m("9000.00"), "interest_rate": "6.9",
                                               "start_date": start.isoformat(), "due_date": date(start.year + 3, start.month, 1).isoformat(),
                                               "account_id": bank, "notes": "Car loan, 36 monthly payments"})
        lent, _ = ws.flows.create_debt(ws.ctx, {"type": "RECEIVABLE", "contact_id": friend, "principal_amount": ws.m("500.00"),
                                                "start_date": month_start(today, 3).isoformat(), "account_id": bank, "notes": "Helped with a deposit"})
        old, _ = ws.flows.create_debt(ws.ctx, {"type": "PAYABLE", "contact_name": "Family (parents)", "principal_amount": ws.m("800.00"),
                                               "start_date": start.isoformat(), "notes": "Borrowed before using FinTrace"})
    ws.count("loans", 3)
    for back in range(4, -1, -1):
        day = month_start(today, back) + timedelta(days=5)
        if ws.past(day):
            with ws.tx():
                ws.flows.repay_debt(ws.ctx, car["id"], {"principal_amount": ws.m("228.00"), "interest_amount": ws.m(Decimal("51.75") - back), "account_id": bank, "repaid_on": day.isoformat()})
            ws.count("loan payments")
    with ws.tx():
        ws.flows.repay_debt(ws.ctx, lent["id"], {"principal_amount": ws.m("200.00"), "account_id": bank, "repaid_on": month_start(today, 1).isoformat(), "notes": "First part back"})
        ws.flows.repay_debt(ws.ctx, old["id"], {"amount": ws.m("800.00"), "account_id": bank, "repaid_on": month_start(today, 2).isoformat(), "notes": "Paid back in full"})
    ws.count("loan payments", 2)

    # Investments
    ws.transfer(month_start(today, 5) + timedelta(days=3), "3000.00", savings, broker, "Fund brokerage")
    ws.transfer(month_start(today, 2) + timedelta(days=3), "1500.00", savings, broker, "Fund brokerage")
    trades = [
        (month_start(today, 5) + timedelta(days=5), "BUY", "GLOBX", "Global Index ETF", "ETF", "20", "84.20", "1.50"),
        (month_start(today, 5) + timedelta(days=5), "BUY", "TECHF", "Tech Leaders Fund", "MUTUAL_FUND", "35", "22.10", "0"),
        (month_start(today, 4) + timedelta(days=10), "BUY", "ACME", "Acme Industries", "STOCK", "10", "41.75", "1.50"),
        (month_start(today, 2) + timedelta(days=6), "BUY", "GLOBX", "Global Index ETF", "ETF", "12", "88.90", "1.50"),
        (month_start(today, 1) + timedelta(days=12), "SELL", "ACME", "Acme Industries", "STOCK", "4", "48.30", "1.50"),
        (month_start(today, 0) + timedelta(days=2), "BUY", "BONDX", "Short-Term Bond Fund", "BOND", "15", "25.04", "0"),
    ]
    for day, side, symbol, name, kind, quantity, price, fees in trades:
        if ws.past(day):
            with ws.tx():
                ws.flows.record_trade(ws.ctx, {"trade_type": side, "symbol": symbol, "name": name, "instrument_type": kind, "quantity": quantity,
                                               "price": price, "fees": fees, "settlement_account_id": broker, "traded_on": day.isoformat()})
            ws.count("trades")
    for back, symbol, amount in [(3, "GLOBX", "14.80"), (1, "TECHF", "9.35"), (0, "GLOBX", "23.68")]:
        day = month_start(today, back) + timedelta(days=1)
        if ws.past(day):
            with ws.tx():
                ws.flows.record_dividend(ws.ctx, {"symbol": symbol, "amount": ws.m(amount), "deposit_account_id": broker, "paid_on": day.isoformat()})
            ws.count("dividends")

    # Recurring items: some due now, one upcoming, one paused.
    next_month = month_start(today, -1)
    recurring = TenantResourceRepository("recurring-transactions")
    schedule = [
        {"transaction_type": "EXPENSE", "description": "Rent", "amount": "1450.00", "frequency": "MONTHLY", "source_account_id": bank, "category_id": cat["Rent"], "next_run_at": next_month},
        {"transaction_type": "INCOME", "description": "Salary", "amount": "5200.00", "frequency": "MONTHLY", "destination_account_id": bank, "category_id": cat["Salary"], "next_run_at": next_month},
        {"transaction_type": "TRANSFER", "description": "Monthly savings", "amount": "600.00", "frequency": "MONTHLY", "source_account_id": bank, "destination_account_id": savings, "next_run_at": next_month + timedelta(days=1)},
        {"transaction_type": "EXPENSE", "description": "Music streaming", "amount": "10.99", "frequency": "MONTHLY", "source_account_id": card, "category_id": cat["Subscriptions"], "next_run_at": today},
        {"transaction_type": "EXPENSE", "description": "Weekly groceries budget", "amount": "95.00", "frequency": "WEEKLY", "source_account_id": bank, "category_id": cat["Groceries"], "next_run_at": today - timedelta(days=2)},
        {"transaction_type": "EXPENSE", "description": "Car insurance", "amount": "640.00", "frequency": "YEARLY", "source_account_id": bank, "category_id": cat["Insurance"], "next_run_at": today + timedelta(days=75)},
    ]
    with ws.tx():
        for item in schedule:
            run_at = item.pop("next_run_at")
            recurring.create(ws.ctx.tenant_id, {**item, "amount": ws.m(item["amount"]), "currency_id": ws.currency_id, "start_date": min(run_at, today), "next_run_at": run_at})
        paused = recurring.create(ws.ctx.tenant_id, {"transaction_type": "EXPENSE", "description": "Gym membership (paused)", "amount": "35.00", "frequency": "MONTHLY",
                                                    "source_account_id": card, "category_id": cat["Health"], "currency_id": ws.currency_id, "start_date": start, "next_run_at": next_month})
        recurring.update(paused, {"is_active": False})
    ws.count("recurring items", len(schedule) + 1)

    # Subscriptions
    for name, amount, frequency, day in [("Music streaming", "10.99", "MONTHLY", 11), ("Video streaming", "15.49", "MONTHLY", 11), ("Cloud storage", "2.99", "MONTHLY", 11), ("Design software", "239.88", "YEARLY", 3)]:
        ws.create("subscriptions", {"name": name, "amount": amount, "currency_id": ws.currency_id, "frequency": frequency, "start_date": start,
                                    "next_billing_date": next_month + timedelta(days=day - 1), "account_id": card, "category_id": cat["Subscriptions"]})

    # Goals, with contributions that really moved money into savings
    goals = {
        "Emergency fund": ws.create("goals", {"name": "Emergency fund", "target_amount": "15000.00", "currency_id": ws.currency_id, "priority": 3, "notes": "Six months of expenses"}),
        "Summer holiday": ws.create("goals", {"name": "Summer holiday", "target_amount": "2400.00", "currency_id": ws.currency_id, "priority": 2, "target_date": date(today.year + 1, 7, 1)}),
        "New laptop": ws.create("goals", {"name": "New laptop", "target_amount": "1800.00", "currency_id": ws.currency_id, "priority": 1}),
    }
    goal_service = GoalService(PostgreSQLLedgerRepository(), HistoryRepository())
    for goal, amounts in [("Emergency fund", ["400.00", "400.00", "350.00"]), ("Summer holiday", ["200.00", "250.00"]), ("New laptop", ["150.00"])]:
        for index, amount in enumerate(amounts):
            day = month_start(today, len(amounts) - index) + timedelta(days=15)
            with ws.tx():
                amount = ws.m(amount)
                goal_service.contribute(ws.ctx, goals[goal], {
                    "occurred_at": business_datetime(day, ws.timezone).isoformat(), "contributed_on": day, "amount": amount, "currency_id": ws.currency_id,
                    "notes": f"Set aside for {goal.lower()}", "reference": "GOAL",
                    "entries": [{"account_id": savings, "debit_amount": amount}, {"account_id": bank, "credit_amount": amount}],
                })
            ws.count("goal contributions")

    # Physical assets and how their value has moved
    assets = AssetService(HistoryRepository())
    for name, kind, bought, value, history in [
        ("Hatchback (2021)", "VEHICLE", start - timedelta(days=400), "14500.00", [(5, "12800.00"), (2, "12300.00"), (0, "11900.00")]),
        ("Laptop and camera gear", "ELECTRONICS", start - timedelta(days=200), "3200.00", [(4, "2700.00"), (0, "2250.00")]),
        ("Gold coins", "GOLD", start - timedelta(days=900), "1800.00", [(5, "2350.00"), (0, "2610.00")]),
    ]:
        asset_id = ws.create("assets", {"name": name, "type": kind, "purchase_value": value, "purchase_date": bought, "currency_id": ws.currency_id})
        with ws.tx():
            for back, worth in history:
                assets.append_valuation(ws.ctx, asset_id, {"value": worth, "currency_id": ws.currency_id, "valued_on": month_start(today, back), "source": "MANUAL"})
        ws.count("asset valuations", len(history))

    # People with different levels of access
    with ws.tx():
        for member in members:
            ws.flows.add_member(ws.ctx, member, make_password, lambda _: [])
    ws.count("members", len(members) + 1)


def seed_business(ws: Workspace, member_email: str) -> None:
    today = ws.today
    start = month_start(today, 2)
    bank = ws.account("Business Current Account", "BANK", opening="2500.00", opened_on=start, institution="Unity Business Bank")
    card = ws.account("Business Card", "CREDIT_CARD", institution="Unity Business Bank")
    sales = ws.category("Client projects", "INCOME")
    software = ws.category("Software and tools", "EXPENSE")
    office = ws.category("Office costs", "EXPENSE")
    fees = ws.category("Bank and payment fees", "EXPENSE")
    client_a = ws.contact("Orchard & Co.")
    client_b = ws.contact("Lumen Labs")
    for back in range(2, -1, -1):
        first = month_start(today, back)
        ws.income(first + timedelta(days=6), Decimal("1800.00") + back * 250, sales, bank, "Website retainer", client_a)
        ws.income(first + timedelta(days=18), Decimal("950.00"), sales, bank, "Logo and identity work", client_b)
        ws.expense(first + timedelta(days=2), "54.00", software, card, "Design suite subscription")
        ws.expense(first + timedelta(days=2), "12.00", software, card, "Domain and email hosting")
        ws.expense(first + timedelta(days=10), "180.00", office, bank, "Co-working desk")
        ws.expense(first + timedelta(days=19), "8.40", fees, bank, "Payment processing fee")
        ws.transfer(first + timedelta(days=24), "66.00", bank, card, "Business card payment")
    with ws.tx():
        ws.flows.add_member(ws.ctx, {"email": member_email, "role": "MEMBER"}, make_password, lambda _: [])
    ws.count("members", 2)


SAMPLE_EQUITY = [
    {"tradingsymbol": "INFY", "exchange": "NSE", "isin": "INE009A01021", "quantity": 25, "average_price": "1412.40", "last_price": "1538.75", "close_price": "1521.10"},
    {"tradingsymbol": "HDFCBANK", "exchange": "NSE", "isin": "INE040A01034", "quantity": 40, "average_price": "1522.10", "last_price": "1694.20", "close_price": "1701.55"},
    {"tradingsymbol": "TATAMOTORS", "exchange": "NSE", "isin": "INE155A01022", "quantity": 60, "average_price": "948.30", "last_price": "902.15", "close_price": "910.40"},
    {"tradingsymbol": "NIFTYBEES", "exchange": "NSE", "isin": "INF204KB14I2", "quantity": 150, "average_price": "238.65", "last_price": "268.90", "close_price": "267.35"},
    {"tradingsymbol": "GOLDBEES", "exchange": "NSE", "isin": "INF204KB17I5", "quantity": 200, "average_price": "51.23", "last_price": "62.48", "close_price": "62.10"},
]
SAMPLE_FUNDS = [
    {"folio": "9104587/22", "fund": "Parag Parikh Flexi Cap Fund - Direct Growth", "tradingsymbol": "INF879O01027", "quantity": "1840.552", "average_price": "66.86", "last_price": "78.92"},
    {"folio": "3310942/71", "fund": "UTI Nifty 50 Index Fund - Direct Growth", "tradingsymbol": "INF789F1AUV1", "quantity": "620.117", "average_price": "142.30", "last_price": "161.84"},
    {"folio": "7722015/08", "fund": "HDFC Short Term Debt Fund - Direct Growth", "tradingsymbol": "INF179K01YM0", "quantity": "2150.000", "average_price": "29.14", "last_price": "30.02"},
]


SAMPLE_SIPS = [
    {"sip_id": "DEMO-1", "fund": "Parag Parikh Flexi Cap Fund - Direct Growth", "tradingsymbol": "INF879O01027", "status": "ACTIVE", "frequency": "monthly", "instalment_amount": 10000, "instalment_day": 5, "completed_instalments": 14, "pending_instalments": -1},
    {"sip_id": "DEMO-2", "fund": "UTI Nifty 50 Index Fund - Direct Growth", "tradingsymbol": "INF789F1AUV1", "status": "ACTIVE", "frequency": "monthly", "instalment_amount": 5000, "instalment_day": 12, "completed_instalments": 9, "pending_instalments": 27},
    {"sip_id": "DEMO-3", "fund": "HDFC Short Term Debt Fund - Direct Growth", "tradingsymbol": "INF179K01YM0", "status": "PAUSED", "frequency": "monthly", "instalment_amount": 3000, "instalment_day": 20, "completed_instalments": 6, "pending_instalments": -1},
]
SAMPLE_POSITIONS = [{"tradingsymbol": "NIFTYBEES", "exchange": "NSE", "product": "MIS", "quantity": 40, "average_price": "267.80", "last_price": "268.90", "pnl": "44.00"}]


def _next_day_of_month(today: date, day: int) -> date:
    candidate = today.replace(day=min(day, 28))
    return candidate if candidate > today else (month_start(today, -1)).replace(day=min(day, 28))


def seed_sample_broker_portfolio(ws: Workspace) -> bool:
    """A sample Zerodha portfolio, stored with status SAMPLE so the app labels it as demo data.

    Also tops up a sample portfolio created by an earlier version of this script
    (cash, SIPs, a position and per-holding history), so the analysis screens have data.
    """
    repo = BrokerRepository()
    with ws.tx():
        connection = repo.connection(BROKER)
        if connection is not None and (connection["status"] != "SAMPLE" or repo.sips(connection["id"])):
            return False  # a real connection, or a sample that is already complete
        connection_id = connection["id"] if connection else repo.save_connection(ws.ctx.tenant_id, ws.ctx.user_id, BROKER, "SAMPLE", "DEMO01", "Demo investor", None, None)
        rows = normalise_holdings(SAMPLE_EQUITY, SAMPLE_FUNDS)
        # Eight weeks of history drifting towards today's prices, with one purchase along the
        # way, so the charts have a shape and "market movement" differs from "change in value".
        for weeks_back in range(8, 0, -1):
            drift = Decimal(1) - Decimal(weeks_back) * Decimal("0.011") + (Decimal("0.02") if weeks_back % 3 == 0 else Decimal(0))
            past = []
            for row in rows:
                held = Decimal("0.75") if weeks_back > 4 and row["symbol"] == "INF879O01027" else Decimal(1)  # a quarter of this fund was bought 4 weeks ago
                past.append({**row, "quantity": row["quantity"] * held, "invested_value": (row["invested_value"] * held).quantize(Decimal("0.01")),
                             "current_value": (row["current_value"] * held * drift).quantize(Decimal("0.01"))})
            day = ws.today - timedelta(weeks=weeks_back)
            repo.save_snapshot(ws.ctx.tenant_id, connection_id, day, past)
            repo.save_holding_snapshots(ws.ctx.tenant_id, connection_id, day, past)
        repo.replace_holdings(ws.ctx.tenant_id, connection_id, rows, ws.today)
        sips = normalise_sips([{**sip, "next_instalment": _next_day_of_month(ws.today, sip["instalment_day"]).isoformat()} for sip in SAMPLE_SIPS])
        repo.replace_extras(ws.ctx.tenant_id, connection_id, Decimal("18450.75"), normalise_positions(SAMPLE_POSITIONS), sips)
    return True


def find_or_create_user(repo: FlowRepository, email: str, first: str, last: str, password_hash: str) -> tuple[object, bool]:
    user = repo.user_by_email(email)
    if user:
        return user["id"], False
    return repo.create_user(email, email, password_hash, first, last), True


def owned_tenant(user_id, slug: str) -> dict | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT id, slug FROM fintrace.list_user_tenants(%s::uuid, FALSE) WHERE slug = %s", [str(user_id), slug])
        row = cursor.fetchone()
    return {"id": row[0]} if row else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--currency", default="USD", help="base currency of the main demo workspace (ISO code)")
    parser.add_argument("--timezone", default="UTC", help="IANA timezone of the demo workspaces, e.g. Asia/Kolkata")
    parser.add_argument("--password", default=os.environ.get("FINTRACE_DEMO_PASSWORD"), help="password for all demo users (generated if omitted)")
    parser.add_argument("--suffix", default="", help="create a separate demo set, e.g. --suffix team2")
    parser.add_argument("--allow-production", action="store_true", help="seed even when ENV=production (demo data cannot be deleted)")
    args = parser.parse_args()

    if os.environ.get("ENV") == "production" and not args.allow_production:
        fail("ENV=production. Demo data can never be deleted from a FinTrace database; pass --allow-production if you really mean it.")
    suffix = "".join(ch for ch in args.suffix.lower() if ch.isalnum())
    tag = f"-{suffix}" if suffix else ""
    plus = f"+{suffix}" if suffix else ""

    generated = not args.password
    password = args.password or secrets.token_urlsafe(12)
    try:
        validate_password(password)
    except ValidationError as exc:
        fail("that password is not acceptable: " + " ".join(exc.messages))
    password_hash = make_password(password)

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT code, id, decimal_places FROM fintrace.currencies WHERE is_active")
            rows = cursor.fetchall()
            currencies = {code: str(currency_id) for code, currency_id, _ in rows}
            decimals = {code: places for code, _, places in rows}
    except DatabaseError as exc:
        fail(f"cannot read the database ({str(exc).strip().splitlines()[0]}). Run scripts/bootstrap_db.py first.")
    code = args.currency.upper()
    if code not in currencies:
        fail(f"currency {code} is not in the database. Run: python scripts/bootstrap_db.py --seed-currencies")

    people = {
        "owner": (f"demo.owner{plus}@fintrace.example", "Dana", "Owner"),
        "member": (f"demo.member{plus}@fintrace.example", "Morgan", "Member"),
        "viewer": (f"demo.viewer{plus}@fintrace.example", "Vic", "Viewer"),
    }
    household_slug, business_slug = f"demo-household{tag}", f"demo-side-business{tag}"

    repo = FlowRepository()
    tenants = TenantResourceRepository("tenants")
    with transaction.atomic():
        owner_id, created_owner = find_or_create_user(repo, *people["owner"], password_hash)
        for role in ("member", "viewer"):
            find_or_create_user(repo, *people[role], password_hash)
        household = owned_tenant(owner_id, household_slug)
        household_id = household["id"] if household else tenants.provision_tenant(owner_id, {"slug": household_slug, "name": f"Demo Household{' ' + suffix if suffix else ''}", "base_currency_id": currencies[code]})
        business = owned_tenant(owner_id, business_slug)
        business_id = business["id"] if business else tenants.provision_tenant(owner_id, {"slug": business_slug, "name": f"Demo Side Business{' ' + suffix if suffix else ''}", "base_currency_id": currencies[code]})
    if not created_owner and generated:
        log("the demo users already exist; their existing password is unchanged.")

    seeded_any = False
    for name, tenant_id, seed in [
        ("Demo Household", household_id, lambda ws: seed_household(ws, currencies.get("EUR"), [
            {"email": people["member"][0], "role": "MEMBER"}, {"email": people["viewer"][0], "role": "VIEWER"}], code)),
        ("Demo Side Business", business_id, lambda ws: seed_business(ws, people["member"][0])),
    ]:
        ws = Workspace(owner_id, tenant_id, currencies[code], args.timezone, decimals[code])
        try:
            with ws.tx():
                if FinancialReadRepository().list_accounts(1, 0):
                    log(f"{name}: already has data, left as it is.")
                    continue
                tenants.update(tenant_id, {"timezone": args.timezone})
                seed(ws)
                totals = FinancialReadRepository().balance_sheet()
        except ApiError as exc:
            fail(f"{name}: {exc.message} {exc.fields or ''} (nothing was saved for this workspace)")
        except DatabaseError as exc:
            fail(f"{name}: the database refused the demo data: {str(exc).strip().splitlines()[0]} (nothing was saved for this workspace)")
        seeded_any = True
        log(f"{name}: seeded. " + ", ".join(f"{count} {what}" for what, count in sorted(ws.counts.items())))
        log(f"{name}: net worth {totals['net_worth']:.2f} {code} (has {totals['assets']:.2f}, owes {totals['liabilities']:.2f})")

    try:
        if seed_sample_broker_portfolio(Workspace(owner_id, household_id, currencies[code], args.timezone, decimals[code])):
            seeded_any = True
            log("Demo Household: sample Zerodha portfolio ready (5 stocks/ETFs, 3 mutual funds, SIPs, cash, 8 weeks of history), labelled as sample data.")
    except DatabaseError as exc:
        fail(f"sample Zerodha portfolio: {str(exc).strip().splitlines()[0]} (run scripts/bootstrap_db.py to apply the latest patches)")

    print()
    print("Demo sign-ins" + ("" if seeded_any else " (nothing new was created)") + ":")
    for role, access in [("owner", "administrator of both workspaces"), ("member", "can record in both workspaces"), ("viewer", "read-only, Demo Household")]:
        print(f"  {people[role][0]:<40} {access}")
    if created_owner:
        print(f"  password: {password}" + ("   (generated; shown only now)" if generated else ""))
    else:
        print("  password: unchanged from when these users were first created")


if __name__ == "__main__":
    main()
