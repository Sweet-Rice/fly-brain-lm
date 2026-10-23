import { cloneElement, useId, type ReactElement } from 'react';

interface TooltipTargetProps {
  'aria-describedby'?: string;
}

interface TooltipProps {
  children: ReactElement<TooltipTargetProps>;
  content: string;
  placement?: 'bottom' | 'top';
}

export function Tooltip({
  children,
  content,
  placement = 'top',
}: TooltipProps) {
  const id = useId();
  const describedBy = [children.props['aria-describedby'], id]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={`ui-tooltip ui-tooltip--${placement}`}>
      {cloneElement(children, { 'aria-describedby': describedBy })}
      <span className="ui-tooltip__content" id={id} role="tooltip">
        {content}
      </span>
    </span>
  );
}
