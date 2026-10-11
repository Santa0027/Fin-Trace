import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from '../../types';

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('').trim();
  return '';
}

function dispatchAction(action: string) {
  window.dispatchEvent(new CustomEvent('fintrace-action', { detail: action }));
}

interface ButtonProps {
  children?: ReactNode;
  kind?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'danger';
  icon?: IconName;
  onClick?: () => void;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

export function Button({
  children,
  kind = 'secondary',
  icon,
  onClick,
  className = '',
  ariaLabel,
  disabled = false,
  type = 'button',
}: ButtonProps) {
  const action = ariaLabel || nodeText(children) || 'Open options';
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      className={`btn btn-${kind} ${className}`}
      disabled={disabled}
      onClick={onClick || (() => dispatchAction(action))}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
