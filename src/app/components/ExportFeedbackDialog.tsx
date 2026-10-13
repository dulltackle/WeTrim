import React, { useLayoutEffect, useRef } from 'react';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';
import { PREVIEW_COPY } from '../copy/preview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ExportFeedback {
  isOpen: boolean;
  type: 'success' | 'error' | 'empty';
  title: string;
  desc: string;
}

export interface ExportFeedbackDialogProps {
  feedback: ExportFeedback | null;
  onClose: () => void;
  onOpenPreview?: () => void;
}

export const ExportFeedbackDialog: React.FC<ExportFeedbackDialogProps> = ({
  feedback,
  onClose,
  onOpenPreview,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const isOpen = feedback?.isOpen ?? false;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      confirmBtnRef.current?.focus();
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }

    return () => {
      if (dialog && dialog.open) {
        dialog.close();
      }
    };
  }, [isOpen]);

  if (!isOpen || !feedback) {
    return null;
  }

  const { type, title, desc } = feedback;

  const stampText =
    type === 'success'
      ? EXPORT_COPY.stampSuccess
      : type === 'error'
      ? EXPORT_COPY.stampError
      : EXPORT_COPY.stampEmpty;
  const stampClass =
    type === 'success'
      ? 'success-stamp border-ok-ink text-ok-ink'
      : type === 'error'
      ? 'error-stamp border-vermilion text-vermilion'
      : 'empty-stamp border-ink-secondary text-ink-secondary';

  return (
    <dialog
      ref={dialogRef}
      className="export-dialog fixed inset-0 m-auto p-0 w-[min(540px,calc(100vw-32px))] bg-sheet-bg border border-sheet-border rounded-sm text-ink-primary overflow-hidden shadow-xl backdrop:bg-ink-primary/50 backdrop:backdrop-blur-[1.5px] open:flex open:flex-col"
      data-testid="export-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="export-dialog-header px-5 py-3.5 border-b border-sheet-border bg-surface-raised flex items-center justify-between">
        <div className="export-title-group flex items-center gap-2.5">
          <span
            className={cn(
              'export-stamp text-[11px] font-mono px-1.5 py-0.5 rounded-[2px] font-semibold tracking-wider border',
              stampClass
            )}
            aria-hidden="true"
          >
            {stampText}
          </span>
          <h2 className="export-dialog-title text-base font-semibold text-ink-primary leading-snug" data-testid="export-dialog-title">
            {title}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="export-dialog-close-btn h-7 w-7 text-ink-tertiary hover:text-ink-primary hover:bg-black/5"
          aria-label={EXPORT_COPY.dialogCloseAria}
          onClick={onClose}
          data-testid="export-dialog-close-x"
        >
          <CloseIcon />
        </Button>
      </div>

      <div className="export-dialog-body p-5 sm:p-6 bg-surface-raised text-sm leading-relaxed text-ink-secondary" data-testid="export-dialog-body">
        <p className="export-dialog-desc break-all whitespace-pre-wrap m-0" data-testid="export-dialog-desc">
          {desc}
        </p>
      </div>

      <div className="export-dialog-footer px-5 py-3 border-t border-sheet-border bg-sheet-bg flex justify-end gap-2.5">
        {type === 'empty' && onOpenPreview && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="action-btn action-open-preview font-medium h-8 px-3 text-xs"
            data-testid="export-dialog-btn-preview"
            onClick={() => {
              onClose();
              onOpenPreview();
            }}
          >
            {PREVIEW_COPY.openButton}
          </Button>
        )}
        <Button
          ref={confirmBtnRef}
          type="button"
          variant="default"
          size="sm"
          className="action-btn action-primary action-confirm-export font-medium h-8 px-4 text-xs bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
          data-testid="export-dialog-btn-close"
          onClick={onClose}
        >
          {type === 'error'
            ? EXPORT_COPY.btnConfirmFailed
            : EXPORT_COPY.btnConfirmSuccess}
        </Button>
      </div>
    </dialog>
  );
};
