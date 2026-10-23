import {
  cloneElement,
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldProps {
  children: ReactElement<{
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }>;
  error?: string | undefined;
  hint?: string | undefined;
  htmlFor: string;
  label: string;
}

export function Field({ children, error, hint, htmlFor, label }: FieldProps) {
  const supportId = useId();
  const accessibility = {
    ...(error || hint ? { 'aria-describedby': supportId } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  };
  const control = cloneElement(children, accessibility);
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {control}
      {(error || hint) && (
        <p
          className={error ? 'ui-field__error' : 'ui-field__hint'}
          id={supportId}
          role={error ? 'alert' : undefined}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = '', ...props }, ref) {
  return (
    <input className={`ui-input ${className}`.trim()} ref={ref} {...props} />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = '', ...props }, ref) {
  return (
    <textarea
      className={`ui-textarea ${className}`.trim()}
      ref={ref}
      {...props}
    />
  );
});
