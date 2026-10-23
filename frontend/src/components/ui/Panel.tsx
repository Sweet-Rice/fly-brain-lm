import { useId, type HTMLAttributes, type ReactNode } from 'react';

interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  eyebrow?: string;
  title?: string;
}

export function Panel({
  children,
  className = '',
  eyebrow,
  title,
  ...props
}: PanelProps) {
  const headingId = useId();
  const labelledBy = props['aria-labelledby'] ?? (title ? headingId : null);
  return (
    <section
      className={`ui-panel ${className}`.trim()}
      {...props}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
    >
      {(eyebrow || title) && (
        <header className="ui-panel__header">
          {eyebrow && <p className="ui-panel__eyebrow">{eyebrow}</p>}
          {title && <h2 id={headingId}>{title}</h2>}
        </header>
      )}
      {children}
    </section>
  );
}
