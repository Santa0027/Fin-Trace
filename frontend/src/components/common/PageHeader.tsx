import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle: string;
  eyebrow?: string;
  action?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow = 'Personal Finance',
  action,
}: PageHeaderProps) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action && <div className="title-actions">{action}</div>}
    </div>
  );
}
