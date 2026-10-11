import { useState } from 'react';
import { Icon } from '../common/Icon';
import type { IconName } from '../../types';

interface SearchModalProps {
  close: () => void;
  setPage: (page: string) => void;
  act: (action: string) => void;
}

const navItems: [string, IconName][] = [
  ['Dashboard', 'home'],
  ['Accounts', 'wallet'],
  ['Transactions', 'swap'],
  ['Income', 'income'],
  ['Expenses', 'expense'],
  ['Transfers', 'transfer'],
  ['Recurring', 'repeat'],
  ['Debts', 'debt'],
  ['Investments', 'trend'],
  ['Reports', 'chart'],
  ['Categories', 'filter'],
  ['Contacts', 'users'],
  ['Settings', 'settings'],
];

export function SearchModal({ close, setPage, act }: SearchModalProps) {
  const [query, setQuery] = useState('');

  const destinations = navItems.filter(([label]) =>
    label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="command" onMouseDown={(e) => e.stopPropagation()}>
        <div className="command-search">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="Search navigation"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Fintrace modules and actions..."
          />
          <kbd>ESC</kbd>
        </div>

        <div className="command-body">
          <p className="eyebrow">Quick financial actions</p>
          <div className="command-grid">
            {([
              ['Add income', 'plus'],
              ['Add expense', 'card'],
              ['Transfer money', 'swap'],
              ['Add account', 'wallet'],
            ] as [string, IconName][]).map(([x, icon]) => (
              <button
                key={x}
                onClick={() => {
                  close();
                  act(x);
                }}
              >
                <Icon name={icon} />
                {x}
              </button>
            ))}
          </div>

          <p className="eyebrow">Jump to module</p>
          {destinations.map(([label, icon]) => (
            <button
              className="command-item"
              key={label}
              onClick={() => {
                setPage(label);
                close();
              }}
            >
              <span>
                <Icon name={icon} />
                {label}
              </span>
              <kbd>↵</kbd>
            </button>
          ))}
          {destinations.length === 0 && (
            <div className="no-results">No pages match “{query}”</div>
          )}
        </div>

        <div className="command-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Select
          </span>
        </div>
      </div>
    </div>
  );
}
