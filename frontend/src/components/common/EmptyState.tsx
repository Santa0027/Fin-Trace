import type { ReactNode } from 'react';
import { Button } from './Button';
import type { IconName } from '../../types';

interface EmptyStateProps {
  title?: string;
  message: string;
  actionText?: string;
  actionIcon?: IconName;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title,
  message,
  actionText,
  actionIcon,
  onAction,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`card empty-state ${className}`} style={{ padding: '32px 20px', textAlign: 'center' }}>
      {title && <h3 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 600 }}>{title}</h3>}
      <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: '12px' }}>{message}</p>
      {actionText && onAction && (
        <Button kind="primary" icon={actionIcon} onClick={onAction}>
          {actionText}
        </Button>
      )}
    </div>
  );
}
