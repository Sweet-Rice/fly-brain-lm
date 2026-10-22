import type { HTMLAttributes, ReactNode } from 'react';

interface StatusProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  pulse?: boolean;
  tone?: 'neutral' | 'positive' | 'warning' | 'negative';
}

export function Status({
  children,
  className = '',
  pulse = false,
  tone = 'neutral',
  ...props
}: StatusProps) {
  return (
    <span
      className={`ui-status ui-status--${tone} ${pulse ? 'ui-status--pulse' : ''} ${className}`.trim()}
      {...props}
    >
      <span aria-hidden="true" className="ui-status__dot" />
      {children}
    </span>
  );
}
