import React, { useRef } from 'react';
import type { ImageDecision, ImageEditTarget, UnlocalizedImage } from '../export/unlocalized-images';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';
import { Button } from '@/components/ui/button';
import { DialogSurface } from '@/components/ui/dialog';

export function UnlocalizedImagesDialog({ images, onDecision, onLocate, onBack }: {
  images: UnlocalizedImage[];
  onDecision: (decision: ImageDecision) => void;
  onBack: () => void;
  onLocate: (target: ImageEditTarget) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const invalidCount = images.filter(i => !i.canKeepExternal).reduce((sum, i) => sum + i.locations.length, 0);

  return (
    <DialogSurface
      ref={dialogRef}
      open
      initialFocus={backRef}
      onDismiss={() => onDecision('cancel')}
      className="export-dialog unlocalized-dialog fixed inset-0 m-auto p-0 w-[min(720px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] bg-sheet-bg border border-sheet-border rounded-sm text-ink-primary overflow-hidden shadow-xl backdrop:bg-ink-primary/50 backdrop:backdrop-blur-[1.5px] open:flex open:flex-col"
      data-testid="unlocalized-dialog"
      aria-labelledby="unlocalized-title"
      aria-describedby="unlocalized-desc"
    >
      <div className="export-dialog-header px-5 py-3.5 border-b border-sheet-border bg-surface-raised flex items-center justify-between shrink-0 gap-4">
        <h2 id="unlocalized-title" className="export-dialog-title text-base font-semibold text-ink-primary leading-snug">
          {EXPORT_COPY.unlocalizedTitle(images.length)}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="export-dialog-close-btn h-7 w-7 text-ink-tertiary hover:text-ink-primary hover:bg-black/5"
          aria-label={EXPORT_COPY.dialogCloseAria}
          onClick={() => onDecision('cancel')}
        >
          <CloseIcon />
        </Button>
      </div>

      <div className="export-dialog-body p-5 sm:p-6 bg-surface-raised overflow-y-auto min-h-0 flex-1 text-sm leading-relaxed text-ink-secondary">
        <p id="unlocalized-desc" className="export-dialog-desc text-sm text-ink-secondary m-0">
          {EXPORT_COPY.unlocalizedDesc}
        </p>
        {invalidCount > 0 && (
          <p className="unlocalized-invalid text-sm text-vermilion mt-4 font-medium m-0" role="alert">
            {EXPORT_COPY.invalidImages(invalidCount)}
          </p>
        )}
        <ol className="unlocalized-list list-none p-0 m-0 divide-y divide-sheet-border mt-4">
          {images.map((image, index) => (
            <li key={`${index}-${image.url}`} className="py-5 first:pt-2 last:pb-0" data-testid="unlocalized-item">
              <p className="unlocalized-reason text-sm font-semibold text-ink-primary mb-2 m-0">{image.reason}</p>
              <p
                className="unlocalized-url text-xs font-mono text-ink-secondary [overflow-wrap:anywhere] select-text mb-3 p-2 bg-black/[0.02] border border-sheet-border/60 rounded-[2px] focus-visible:outline-2 focus-visible:outline-prussian-blue outline-offset-2 m-0"
                tabIndex={0}
                aria-label={EXPORT_COPY.imageAddress}
              >
                {image.url || EXPORT_COPY.emptyImageAddress}
              </p>
              <ul className="unlocalized-locations list-none p-0 m-0 space-y-3">
                {image.locations.map((location, i) => (
                  <li key={`${location.blockId}-${i}`} className="text-xs text-ink-secondary">
                    <p className="[overflow-wrap:anywhere] mb-2 m-0">
                      #{location.order} · {location.summary}
                    </p>
                    <div className="unlocalized-actions flex gap-2 flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="action-btn action-return h-7 text-xs font-normal"
                        data-testid="image-locate"
                        aria-label={EXPORT_COPY.locateImageAria(location.order)}
                        onClick={() => onLocate(location)}
                      >
                        {EXPORT_COPY.locateImage}
                      </Button>
                      {location.definition && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="action-btn action-return h-7 text-xs font-normal"
                          data-testid="image-definition"
                          onClick={() => onLocate(location.definition!)}
                        >
                          {EXPORT_COPY.locateDefinition(location.definition.order)}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      <div className="export-dialog-footer px-5 py-3 border-t border-sheet-border bg-sheet-bg flex justify-end gap-2.5 shrink-0 flex-wrap max-sm:p-3">
        <Button
          ref={backRef}
          type="button"
          variant="outline"
          size="sm"
          className="action-btn action-return h-8 text-xs font-medium"
          data-testid="image-back"
          onClick={onBack}
        >
          {EXPORT_COPY.backToEdit}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="action-btn action-return h-8 text-xs font-medium"
          data-testid="image-retry"
          onClick={() => onDecision('retry')}
        >
          {EXPORT_COPY.retryImages}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="action-btn action-primary action-confirm-export h-8 text-xs font-medium bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse max-sm:w-full"
          data-testid="image-continue"
          disabled={images.some((i) => !i.canKeepExternal)}
          onClick={() => onDecision('continue')}
        >
          {EXPORT_COPY.keepExternal}
        </Button>
      </div>
    </DialogSurface>
  );
}
