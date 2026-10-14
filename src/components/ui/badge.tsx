import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-prussian-blue focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-prussian-blue text-ink-inverse shadow hover:bg-prussian-blue-strong',
        secondary:
          'border-prussian-blue-border bg-prussian-blue-subtle text-prussian-blue-strong hover:bg-prussian-blue-subtle-hover',
        destructive:
          'border-transparent bg-vermilion text-ink-inverse shadow hover:bg-vermilion-strong',
        outline: 'text-ink-primary border-sheet-border bg-surface-raised',
        success:
          'border-transparent bg-ok text-ink-inverse',
        warning:
          'border-amber-border bg-amber-subtle text-amber-ink',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
