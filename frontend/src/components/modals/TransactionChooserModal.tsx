import { Icon } from '../common/Icon';
import { Button } from '../common/Button';

interface TransactionChooserModalProps {
  close: () => void;
  onSelect: (type: 'Add income' | 'Add expense' | 'Transfer money' | 'Investments' | 'Debts') => void;
}

export function TransactionChooserModal({ close, onSelect }: TransactionChooserModalProps) {
  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <div
        className="action-modal card chooser-modal"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: '580px' }}
      >
        <div className="drawer-head">
          <div>
            <p className="eyebrow">New Entry</p>
            <h2 style={{ fontSize: '20px', marginTop: '2px' }}>What happened?</h2>
            <p>Select the type of movement to record in your ledger.</p>
          </div>
          <Button kind="icon" ariaLabel="Close dialog" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="chooser-grid" style={{ padding: '24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          {/* Income Option */}
          <button
            type="button"
            className="chooser-card card"
            onClick={() => onSelect('Add income')}
            style={{
              padding: '20px',
              textAlign: 'left',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'all 0.18s ease',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'var(--primary-soft)',
                color: 'var(--primary)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="income" size={22} />
            </div>
            <div>
              <strong style={{ fontSize: '15px', display: 'block', color: 'var(--text)' }}>
                Money came in
              </strong>
              <span className="good" style={{ fontWeight: 700, fontSize: '12px' }}>
                Income
              </span>
              <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '11px', lineHeight: 1.4 }}>
                Salary, client invoice paid, consulting fee, freelance earnings, or dividends.
              </p>
            </div>
          </button>

          {/* Expense Option */}
          <button
            type="button"
            className="chooser-card card"
            onClick={() => onSelect('Add expense')}
            style={{
              padding: '20px',
              textAlign: 'left',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'all 0.18s ease',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: '#fff2df',
                color: 'var(--coral)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="expense" size={22} />
            </div>
            <div>
              <strong style={{ fontSize: '15px', display: 'block', color: 'var(--text)' }}>
                Money went out
              </strong>
              <span style={{ color: 'var(--coral)', fontWeight: 700, fontSize: '12px' }}>
                Expense
              </span>
              <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '11px', lineHeight: 1.4 }}>
                Rent, groceries, dining, utility bills, shopping, software subscriptions, or travel.
              </p>
            </div>
          </button>

          {/* Transfer Option */}
          <button
            type="button"
            className="chooser-card card"
            onClick={() => onSelect('Transfer money')}
            style={{
              padding: '20px',
              textAlign: 'left',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'all 0.18s ease',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: '#edf0ff',
                color: '#5369bf',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="swap" size={22} />
            </div>
            <div>
              <strong style={{ fontSize: '15px', display: 'block', color: 'var(--text)' }}>
                Moved between accounts
              </strong>
              <span style={{ color: '#5369bf', fontWeight: 700, fontSize: '12px' }}>
                Transfer
              </span>
              <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '11px', lineHeight: 1.4 }}>
                Move funds between checking, savings, ATM cash, or investment trading balances.
              </p>
            </div>
          </button>

          {/* More / Asset & Liability Option */}
          <button
            type="button"
            className="chooser-card card"
            onClick={() => onSelect('Investments')}
            style={{
              padding: '20px',
              textAlign: 'left',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'all 0.18s ease',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'var(--surface-3)',
                color: 'var(--text-2)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="trend" size={22} />
            </div>
            <div>
              <strong style={{ fontSize: '15px', display: 'block', color: 'var(--text)' }}>
                Investments & Debts
              </strong>
              <span style={{ color: 'var(--text-2)', fontWeight: 700, fontSize: '12px' }}>
                More Workflows
              </span>
              <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '11px', lineHeight: 1.4 }}>
                Trade stocks, record ETF positions, or track home loan/car EMI repayments.
              </p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
