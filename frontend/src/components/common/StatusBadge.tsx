interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const norm = (status || '').toUpperCase();
  let badgeStyle = 'badge';

  if (norm === 'ACTIVE' || norm === 'COMPLETED' || norm === 'PAID') {
    badgeStyle = 'badge';
  } else if (norm === 'PENDING' || norm === 'DRAFT') {
    badgeStyle = 'badge warning';
  } else if (norm === 'PAUSED' || norm === 'INACTIVE') {
    badgeStyle = 'badge neutral';
  } else if (norm === 'CANCELLED' || norm === 'REVERSED') {
    badgeStyle = 'badge danger';
  }

  return (
    <span className={`${badgeStyle} ${className}`}>
      {status ? status.replace(/_/g, ' ') : 'Active'}
    </span>
  );
}
