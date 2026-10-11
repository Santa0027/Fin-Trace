import { Button } from './Button';

interface ErrorStateProps {
  error: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ error, onRetry, className = '' }: ErrorStateProps) {
  return (
    <div className={`card app-state error-state ${className}`} style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Unable to load data</strong>
          <span style={{ fontSize: '11px', opacity: 0.85 }}>{error}</span>
        </div>
        {onRetry && (
          <Button kind="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
