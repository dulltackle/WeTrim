import React, { useLayoutEffect, useRef } from 'react';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';
import { PREVIEW_COPY } from '../copy/preview';

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
      ? 'success-stamp'
      : type === 'error'
      ? 'error-stamp'
      : 'empty-stamp';

  return (
    <dialog
      ref={dialogRef}
      className="export-dialog"
      data-testid="export-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="export-dialog-header">
        <div className="export-title-group">
          <span className={`export-stamp ${stampClass}`} aria-hidden="true">
            {stampText}
          </span>
          <h2 className="export-dialog-title" data-testid="export-dialog-title">
            {title}
          </h2>
        </div>
        <button
          type="button"
          className="export-dialog-close-btn"
          aria-label={EXPORT_COPY.dialogCloseAria}
          onClick={onClose}
          data-testid="export-dialog-close-x"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="export-dialog-body" data-testid="export-dialog-body">
        <p className="export-dialog-desc" data-testid="export-dialog-desc">
          {desc}
        </p>
      </div>

      <div className="export-dialog-footer">
        {type === 'empty' && onOpenPreview && (
          <button
            type="button"
            className="action-btn action-open-preview"
            data-testid="export-dialog-btn-preview"
            onClick={() => {
              onClose();
              onOpenPreview();
            }}
          >
            {PREVIEW_COPY.openButton}
          </button>
        )}
        <button
          ref={confirmBtnRef}
          type="button"
          className="action-btn action-primary action-confirm-export"
          data-testid="export-dialog-btn-close"
          onClick={onClose}
        >
          {type === 'error'
            ? EXPORT_COPY.btnConfirmFailed
            : EXPORT_COPY.btnConfirmSuccess}
        </button>
      </div>
    </dialog>
  );
};
