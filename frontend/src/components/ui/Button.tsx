import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: 'default' | 'compact';
  variant?: 'primary' | 'secondary' | 'quiet';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className = '',
      size = 'default',
      type = 'button',
      variant = 'secondary',
      ...props
    }: ButtonProps,
    ref,
  ) {
    return (
      <button
        className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()}
        ref={ref}
        type={type}
        {...props}
      >
        {children}
      </button>
    );
  },
);
