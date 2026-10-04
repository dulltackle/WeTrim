import React, { useLayoutEffect, useRef } from 'react';
import type { ImageDecision, ImageEditTarget, UnlocalizedImage } from '../export/unlocalized-images';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';

export function UnlocalizedImagesDialog({ images, onDecision, onLocate, onBack }: {
  images: UnlocalizedImage[];
  onDecision: (decision: ImageDecision) => void;
  onBack: () => void;
  onLocate: (target: ImageEditTarget) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const invalidCount = images.filter(i => !i.canKeepExternal).reduce((sum, i) => sum + i.locations.length, 0);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    backRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="export-dialog unlocalized-dialog" data-testid="unlocalized-dialog"
      aria-labelledby="unlocalized-title" aria-describedby="unlocalized-desc"
      onCancel={event => { event.preventDefault(); onDecision('cancel'); }}>
      <div className="export-dialog-header">
        <h2 id="unlocalized-title" className="export-dialog-title">{EXPORT_COPY.unlocalizedTitle(images.length)}</h2>
        <button type="button" className="export-dialog-close-btn" aria-label={EXPORT_COPY.dialogCloseAria}
          onClick={() => onDecision('cancel')}><CloseIcon /></button>
      </div>
      <div className="export-dialog-body">
        <p id="unlocalized-desc" className="export-dialog-desc">{EXPORT_COPY.unlocalizedDesc}</p>
        {invalidCount > 0 && <p className="unlocalized-invalid" role="alert">{EXPORT_COPY.invalidImages(invalidCount)}</p>}
        <ol className="unlocalized-list">
          {images.map((image, index) => (
            <li key={`${index}-${image.url}`} data-testid="unlocalized-item">
              <p className="unlocalized-reason">{image.reason}</p>
              <p className="unlocalized-url" tabIndex={0} aria-label={EXPORT_COPY.imageAddress}>{image.url || EXPORT_COPY.emptyImageAddress}</p>
              <ul className="unlocalized-locations">
                {image.locations.map((location, i) => (
                  <li key={`${location.blockId}-${i}`}>
                    <p>#{location.order} · {location.summary}</p>
                    <div className="unlocalized-actions">
                      <button type="button" className="action-btn action-return" data-testid="image-locate"
                        aria-label={EXPORT_COPY.locateImageAria(location.order)} onClick={() => onLocate(location)}>{EXPORT_COPY.locateImage}</button>
                      {location.definition && <button type="button" className="action-btn action-return" data-testid="image-definition"
                        onClick={() => onLocate(location.definition!)}>{EXPORT_COPY.locateDefinition(location.definition.order)}</button>}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
      <div className="export-dialog-footer">
        <button ref={backRef} type="button" className="action-btn action-return" data-testid="image-back" onClick={onBack}>{EXPORT_COPY.backToEdit}</button>
        <button type="button" className="action-btn action-return" data-testid="image-retry" onClick={() => onDecision('retry')}>{EXPORT_COPY.retryImages}</button>
        <button type="button" className="action-btn action-primary action-confirm-export" data-testid="image-continue"
          disabled={images.some(i => !i.canKeepExternal)} onClick={() => onDecision('continue')}>{EXPORT_COPY.keepExternal}</button>
      </div>
    </dialog>
  );
}
