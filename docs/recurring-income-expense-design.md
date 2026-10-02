# Recurring Income and Expense Execution Design

The current schema can safely execute recurring `TRANSFER` rows because both accounting sides are explicit: `source_account_id` and `destination_account_id`.

Recurring `INCOME` and `EXPENSE` should remain fail-closed until the schema stores enough account information to construct both ledger entries without guessing.

## Proposed Columns

Add explicit counterpart account fields to `recurring_transactions`:

- `income_account_id UUID NULL`
- `expense_account_id UUID NULL`

These must use tenant-aware composite foreign keys, not plain single-column account references:

```sql
FOREIGN KEY (tenant_id, income_account_id)
    REFERENCES fintrace.accounts(tenant_id, id)

FOREIGN KEY (tenant_id, expense_account_id)
    REFERENCES fintrace.accounts(tenant_id, id)
```

The foreign keys must allow null account columns for transaction types where the field is not applicable.

Keep existing fields:

- `source_account_id`
- `destination_account_id`
- `amount`
- `currency_id`
- `category_id`

## Semantics

`INCOME`:

- Debit `destination_account_id`, the cash/bank account receiving money.
- Credit `income_account_id`, the income account.
- `source_account_id` remains unused unless the product later models external source semantics separately.

`EXPENSE`:

- Debit `expense_account_id`, the expense account.
- Credit `source_account_id`, the cash/bank account paying money.
- `destination_account_id` remains unused unless the product later models payee-side semantics separately.

`TRANSFER`:

- Debit `destination_account_id`.
- Credit `source_account_id`.
- `income_account_id` and `expense_account_id` must be null.

## Constraints

Add validation so each transaction type has exactly the fields it needs:

- `TRANSFER`: requires `source_account_id`, `destination_account_id`; forbids `income_account_id`, `expense_account_id`.
- `INCOME`: requires `destination_account_id`, `income_account_id`; forbids `expense_account_id`.
- `EXPENSE`: requires `source_account_id`, `expense_account_id`; forbids `income_account_id`.
- All participating accounts must belong to the same tenant through composite foreign keys and must use the same currency as the recurring definition.
- Category type must match the recurring type where `category_id` is used.

## API DTO Changes

Create/update DTOs should accept:

- `income_account_id` only for `INCOME`.
- `expense_account_id` only for `EXPENSE`.
- Existing transfer fields for `TRANSFER`.

The API should reject unsupported field combinations before calling the repository, while database constraints remain authoritative.

## Migration and Backfill Impact

- Existing `TRANSFER` rows can be backfilled with null `income_account_id` and `expense_account_id`.
- Existing `INCOME` and `EXPENSE` recurring definitions cannot be executed safely unless the missing account is collected from the user or mapped through a product-approved rule.
- The migration should add columns nullable first, populate/update existing rows through an explicit backfill workflow, then enable validation constraints.

No migration is applied yet; this is the smallest clean schema/product direction for a future change.
