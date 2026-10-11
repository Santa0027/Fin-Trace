export function LoadingSkeleton({
  lines = 3,
  message = 'Loading live data...',
}: {
  lines?: number;
  message?: string;
}) {
  return (
    <div className="card app-state" style={{ padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--primary)', animation: 'pulse 1s infinite' }} />
        <span>{message}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            style={{
              height: '14px',
              borderRadius: '4px',
              background: 'var(--surface-3)',
              width: `${Math.max(40, 100 - i * 18)}%`,
              opacity: 0.6,
            }}
          />
        ))}
      </div>
    </div>
  );
}
