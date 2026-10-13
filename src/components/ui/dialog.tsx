import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui/react';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

const Dialog = BaseDialog.Root;
const DialogTrigger = BaseDialog.Trigger;
// 原生模态内的子弹窗必须留在该模态的顶层子树中，不能默认挂到 inert 的 body 分支。
const DialogPortalContainerContext = React.createContext<
  React.ComponentProps<typeof BaseDialog.Portal>['container']
>(undefined);
const DialogPortalContainer = DialogPortalContainerContext.Provider;
const DialogPortal = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof BaseDialog.Portal>
>(({ container, ...props }, ref) => {
  const inheritedContainer = React.useContext(DialogPortalContainerContext);
  return <BaseDialog.Portal ref={ref} container={container ?? inheritedContainer} {...props} />;
});
DialogPortal.displayName = 'DialogPortal';
const DialogClose = BaseDialog.Close;

const DialogBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => (
  <BaseDialog.Backdrop
    ref={ref}
    className={cn(
      'fixed inset-0 min-h-dvh bg-ink-primary/50 backdrop-blur-[1.5px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 z-50',
      className
    )}
    {...props}
  />
));
DialogBackdrop.displayName = 'DialogBackdrop';

const DialogOverlay = DialogBackdrop;

const DialogPopup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof BaseDialog.Popup>
>(({ className, children, ...props }, ref) => (
  <BaseDialog.Popup
    ref={ref}
    className={cn(
      'focus:outline-none',
      className
    )}
    {...props}
  >
    {children}
  </BaseDialog.Popup>
));
DialogPopup.displayName = 'DialogPopup';

export interface DialogContentProps
  extends React.ComponentProps<typeof BaseDialog.Popup> {
  showCloseButton?: boolean;
  closeButtonLabel?: string;
  backdropClassName?: string;
  renderAsDialog?: boolean;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      showCloseButton = false,
      closeButtonLabel = '关闭',
      backdropClassName,
      renderAsDialog = false,
      render,
      ...props
    },
    ref
  ) => {
    return (
      <DialogPortal>
        <DialogBackdrop className={backdropClassName} />
        <BaseDialog.Popup
          ref={ref}
          render={render ?? (renderAsDialog ? <dialog open /> : undefined)}
          className={cn(
            'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-surface-raised border border-sheet-border p-6 shadow-xl rounded-sm transition-[scale,opacity] duration-150 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 focus:outline-none',
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <BaseDialog.Close
              className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-prussian-blue disabled:pointer-events-none text-ink-secondary hover:text-ink-primary cursor-pointer"
              aria-label={closeButtonLabel}
            >
              <X className="size-4" />
            </BaseDialog.Close>
          )}
        </BaseDialog.Popup>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentProps<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight text-ink-primary', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentProps<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description
    ref={ref}
    className={cn('text-sm text-ink-secondary leading-relaxed', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogPortalContainer,
  DialogClose,
  DialogBackdrop,
  DialogOverlay,
  DialogPopup,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
