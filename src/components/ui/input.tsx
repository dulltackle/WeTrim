import * as React from 'react';
import { Input as BaseInput } from '@base-ui/react';
import { cn } from '@/lib/utils';

export interface InputProps
  extends React.ComponentProps<typeof BaseInput> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <BaseInput
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-sheet-border bg-surface-raised px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink-primary placeholder:text-ink-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-prussian-blue disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
