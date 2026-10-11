import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { useSubmission } from '../common/useSubmission';
import { accountsApi } from '../../lib/api/accountsApi';
import { investmentsApi } from '../../lib/api/investmentsApi';
import { notifyDataChanged, useTenantQuery } from '../../hooks/useTenantQuery';
import { formatMoney, parseAmountInput, toNumber } from '../../lib/money';
import { todayISO } from '../../lib/dates';
import type { Holding } from '../../types';

const INSTRUMENT_TYPES: [string, string][] = [
  ['STOCK', 'Stock'], ['ETF', 'ETF'], ['MUTUAL_FUND', 'Mutual fund'], ['BOND', 'Bond'], ['CRYPTO', 'Crypto'], ['OTHER', 'Other'],
];

interface TradeModalProps {
  holdings: Holding[];
  initialType?: 'BUY' | 'SELL';
  close: () => void;
  saved: () => void;
}

export function TradeModal({ holdings, initialType = 'BUY', close, saved }: TradeModalProps) {
  const accountsQuery = useTenantQuery(() => accountsApi.list(), [], { topics: ['accounts'] });
  const accounts = useMemo(() => (accountsQuery.data?.results ?? []).filter((a) => a.is_payment_account && a.category === 'ASSET'), [accountsQuery.data]);

  const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>(holdings.length ? initialType : 'BUY');
  const [symbol, setSymbol] = useState('');
  const [instrumentType, setInstrumentType] = useState('STOCK');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayISO);
  const submission = useSubmission('trade');
  const buying = tradeType === 'BUY';
  const holding = holdings.find((h) => h.symbol === symbol.trim().toUpperCase());
  const isNewInstrument = buying && symbol.trim() !== '' && !holding;

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    submission.touched();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!symbol.trim()) next.symbol = buying ? 'Enter the symbol or name of what you bought.' : 'Choose what you sold.';
    const qty = parseAmountInput(quantity, 8);
    if (qty.error) next.quantity = qty.error.replace('amount', 'quantity').replace('Amount', 'Quantity');
    const unit = parseAmountInput(price, 6);
    if (unit.error) next.price = unit.error.replace('amount', 'price').replace('Amount', 'Price');
    let feeValue = '0';
    if (fees.trim() && !/^0+(\.0+)?$/.test(fees.trim())) {
      const parsed = parseAmountInput(fees);
      if (parsed.error) next.fees = parsed.error;
      else feeValue = parsed.value as string;
    }
    if (!buying && holding && qty.value && toNumber(qty.value) > toNumber(holding.quantity)) {
      next.quantity = `You hold ${Number(holding.quantity)} ${holding.symbol}.`;
    }
    if (!accountId) next.settlement_account_id = 'Choose an account.';
    if (!date) next.traded_on = 'Choose a date.';
    submission.setErrors(next);
    if (Object.keys(next).length) return;

    const result = await submission.run(
      (key) =>
        investmentsApi.recordTrade(
          {
            trade_type: tradeType,
            symbol: symbol.trim().toUpperCase(),
            instrument_type: isNewInstrument ? instrumentType : undefined,
            quantity: qty.value as string,
            price: unit.value as string,
            fees: feeValue,
            settlement_account_id: accountId,
            traded_on: date,
          },
          key
        ),
      'The trade could not be recorded.'
    );
    if (result) {
      notifyDataChanged(['investments', 'accounts', 'transactions', 'reports']);
      saved();
    }
  };

  const fieldError = (field: string) => (submission.errors[field] ? <small className="field-error" role="alert">{submission.errors[field]}</small> : null);
  const accountLabel = buying ? 'Paid from' : 'Proceeds received into';
  const account = accounts.find((a) => a.id === accountId);
  const estimate = toNumber(quantity) * toNumber(price) + (buying ? 1 : -1) * toNumber(fees);

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label="Record investment trade" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>{buying ? 'Record a purchase' : 'Record a sale'}</h2>
            <p>{buying ? 'Buying an investment moves money from an account into your holdings. It is not an expense.' : 'Selling moves money back to an account. Only the gain or loss counts as income or expense.'}</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>

        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {submission.error && <div className="auth-error" role="alert">{submission.error}</div>}

          <div className="tabs" role="group" aria-label="Trade type" style={{ margin: '0 0 12px' }}>
            <button type="button" aria-pressed={buying} className={buying ? 'active' : ''} onClick={() => change(setTradeType)('BUY')}>Buy</button>
            <button type="button" aria-pressed={!buying} className={!buying ? 'active' : ''} disabled={holdings.length === 0} onClick={() => { change(setTradeType)('SELL'); setSymbol(''); }}>Sell</button>
          </div>

          {buying ? (
            <div className="field-row">
              <label className="field">
                Investment
                <input autoFocus aria-label="Investment symbol" aria-invalid={Boolean(submission.errors.symbol)} list="trade-symbols" value={symbol} maxLength={50}
                  onChange={(e) => change(setSymbol)(e.target.value)} placeholder="Symbol, e.g. VTI" />
                <datalist id="trade-symbols">{holdings.map((h) => <option key={h.position_id} value={h.symbol}>{h.instrument_name}</option>)}</datalist>
                {fieldError('symbol')}
              </label>
              {isNewInstrument && (
                <label className="field">
                  Type
                  <select aria-label="Investment type" value={instrumentType} onChange={(e) => change(setInstrumentType)(e.target.value)}>
                    {INSTRUMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              )}
            </div>
          ) : (
            <label className="field">
              Investment
              <select aria-label="Investment to sell" aria-invalid={Boolean(submission.errors.symbol)} value={symbol} onChange={(e) => change(setSymbol)(e.target.value)}>
                <option value="">Choose a holding</option>
                {holdings.map((h) => <option key={h.position_id} value={h.symbol}>{h.symbol} · {Number(h.quantity)} held</option>)}
              </select>
              {fieldError('symbol')}
            </label>
          )}

          <div className="field-row">
            <label className="field">
              Quantity
              <input aria-label="Quantity" aria-invalid={Boolean(submission.errors.quantity)} value={quantity} inputMode="decimal" autoComplete="off" onChange={(e) => change(setQuantity)(e.target.value)} />
              {fieldError('quantity')}
            </label>
            <label className="field">
              Price each
              <input aria-label="Price each" aria-invalid={Boolean(submission.errors.price)} value={price} inputMode="decimal" autoComplete="off" placeholder="0.00" onChange={(e) => change(setPrice)(e.target.value)} />
              {fieldError('price')}
            </label>
            <label className="field">
              Fees <small>Optional</small>
              <input aria-label="Fees" aria-invalid={Boolean(submission.errors.fees)} value={fees} inputMode="decimal" autoComplete="off" placeholder="0.00" onChange={(e) => change(setFees)(e.target.value)} />
              {fieldError('fees')}
            </label>
          </div>

          <label className="field">
            {accountLabel}
            <select aria-label={accountLabel} aria-invalid={Boolean(submission.errors.settlement_account_id)} value={accountId} onChange={(e) => change(setAccountId)(e.target.value)}>
              <option value="">{accountsQuery.loading ? 'Loading…' : 'Choose an account'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {formatMoney(a.balance_amount, a.currency_code)}</option>)}
            </select>
            {fieldError('settlement_account_id')}
          </label>

          <label className="field">
            Date
            <input aria-label="Trade date" type="date" aria-invalid={Boolean(submission.errors.traded_on)} value={date} max={todayISO()} onChange={(e) => change(setDate)(e.target.value)} />
            {fieldError('traded_on')}
          </label>

          {estimate > 0 && (
            <p style={{ fontSize: '12px', color: 'var(--muted)' }}>
              About {formatMoney(estimate, account?.currency_code)} will {buying ? 'leave' : 'arrive in'} {account?.name ?? 'the account'}. The exact amount is calculated when you save.
            </p>
          )}
        </div>

        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={submission.submitting}>{submission.submitting ? 'Saving…' : buying ? 'Record purchase' : 'Record sale'}</button>
        </div>
      </form>
    </div>
  );
}
