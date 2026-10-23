import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: 'default' | 'compact';
  variant?: 'primary' | 'secondary' | 'quiet';
}

export function Button({
  children,
  className = '',
  size = 'default',
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
