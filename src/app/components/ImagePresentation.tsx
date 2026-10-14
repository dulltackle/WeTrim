import React, {
  memo,
  useCallback,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { IMAGE_COPY } from '../copy/image-presentation';
import { SEARCH_IGNORE_ATTR } from '../search/text-search';

/**
 * 超长竖图判定阈值：高宽比超过它才算「长图」，只按原图比例判断，
 * 不看显示尺寸——高清的普通横图、方图缩放后同样会低于原图高度，不能据此误判。
 */
const TALL_IMAGE_RATIO = 2;

// 界面辅助文字的容器属性：不参与搜索偏移换算（见 text-search.ts）
const searchIgnoreProps = { [SEARCH_IGNORE_ATTR]: 'true' };

export interface ImagePresentationProps {
  src: string;
  alt?: string;
  title?: string;
  className?: string;
}

/**
 * 截短图片 URL 辅助函数：提取域名与截短路径，供失败占位展示
 */
export function formatImageErrorUrl(url: string): { domain: string; path: string } {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const fullPath = parsed.pathname + parsed.search;
    const path =
      fullPath.length > 36
        ? fullPath.slice(0, 18) + '…' + fullPath.slice(-14)
        : fullPath || '/';
    return { domain, path };
  } catch {
    const path = url.length > 32 ? url.slice(0, 16) + '…' + url.slice(-12) : url;
    return { domain: '', path };
  }
}

/**
 * 查看完整原图浮层组件（统一使用 Dialog 基础组件）
 */
interface ImageViewerModalProps {
  src: string;
  alt: string;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLDivElement | null>;
}

const ImageViewerModal: React.FC<ImageViewerModalProps> = ({ src, alt, onClose, returnFocus }) => {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop className="fixed inset-0 min-h-dvh bg-ink-primary/88 backdrop-blur-[3px] z-50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPopup
          render={(popupProps) => (
            <dialog
              {...popupProps}
              open
              className={popupProps.className}
              onCancel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              {...searchIgnoreProps}
            />
          )}
          initialFocus={closeBtnRef}
          finalFocus={returnFocus}
          className={cn(
            'image-viewer-overlay fixed inset-0 z-50 w-full h-full max-w-none max-h-none m-0 p-0 border-0',
            'bg-ink-primary/88 text-ink-inverse flex flex-col items-center justify-between',
            'transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 focus:outline-none'
          )}
          data-testid="image-viewer-overlay"
          aria-label={IMAGE_COPY.viewerTitle}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onClose();
            }
          }}
        >
          <div className="image-viewer-toolbar w-full px-6 py-3 flex justify-between items-center bg-black/40 text-ink-inverse shrink-0 box-border">
            <span className="image-viewer-title text-sm font-medium text-white/85 truncate max-w-[calc(100%-100px)]">
              {alt || IMAGE_COPY.viewerTitle}
            </span>
            <Button
              ref={closeBtnRef}
              type="button"
              variant="outline"
              size="sm"
              className="image-viewer-close-btn h-auto px-3.5 py-1 text-xs font-semibold rounded-xs bg-white/15 border-white/30 text-ink-inverse hover:bg-white/30 hover:text-white"
              data-testid="image-viewer-close-btn"
              aria-label={IMAGE_COPY.viewerCloseAria}
              onClick={onClose}
            >
              {IMAGE_COPY.viewerClose}
            </Button>
          </div>
          <div
            className="image-viewer-body flex-1 w-full overflow-auto flex items-center justify-center p-6 box-border"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                onClose();
              }
            }}
          >
            <img
              src={src}
              alt={alt || IMAGE_COPY.defaultImageAlt}
              className="image-viewer-full-img max-w-full h-auto rounded-xs shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
              data-testid="image-viewer-full-img"
            />
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
};

/**
 * 依据 Issue #30, #73 与设计简报：
 * 清洗页专用的图片呈现层：
 * - 正常时直接把图片资源的远程 URL 放进 <img src> 显示缩略图；清洗期不 fetch 图片字节
 * - 限高缩略图：保留态下图片在版心内按原比例显示，限最大高度（约半屏，min(50vh, 480px)）
 * - 超长竖图（高宽比 > TALL_IMAGE_RATIO）：按版心宽度铺开、只显示顶部，底部加渐隐与「长图」标记
 * - 查看原图：点击缩略图或聚焦后按回车，在浮层中看完整原图；Esc 关闭，焦点平稳回到原缩略图
 * - 图片失败：原位占位，写明「图片没有加载出来」，附域名与截短的地址，加「重试」按钮
 * - 重试只让 <img> 以同一 src 重新请求，不改 Markdown 里保存的地址
 * - 所有图片用 loading="lazy" 与 decoding="async"，保证图片加载不阻塞逐字编辑
 * - 图片的 load/error 事件在组件内部处理，不越过 BlockList 去查 DOM
 * - 纯键盘操作与无障碍标签
 */
export const ImagePresentation = memo<ImagePresentationProps>(
  ({ src, alt = '', title, className = '' }) => {
    const [status, setStatus] = useState<'loading' | 'loaded' | 'error' | 'retrying'>('loading');
    const [isTall, setIsTall] = useState(false);
    const [viewerOpen, setViewerOpen] = useState(false);
    const [loadAttempts, setLoadAttempts] = useState(0);

    const triggerContainerRef = useRef<HTMLDivElement | null>(null);

    const { domain, path } = formatImageErrorUrl(src);

    // 图片加载成功
    const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setStatus('loaded');

      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setIsTall(img.naturalHeight / img.naturalWidth > TALL_IMAGE_RATIO);
      }
    }, []);

    // 图片加载失败
    const handleError = useCallback(() => {
      setStatus('error');
    }, []);

    // 点击重试：递增 key 让 <img> 以同一 src 重新挂载、重新请求，不改动 Markdown 保存的地址
    const handleRetry = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setStatus('retrying');
      setLoadAttempts((c) => c + 1);
    }, []);

    // 打开全图浮层
    const handleOpenViewer = useCallback(() => {
      if (status === 'loaded') {
        setViewerOpen(true);
      }
    }, [status]);

    // 关闭全图浮层并恢复焦点至缩略图
    const handleCloseViewer = useCallback(() => {
      setViewerOpen(false);
    }, []);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpenViewer();
        }
      },
      [handleOpenViewer]
    );

    return (
      <div
        className={cn("image-presentation-block relative my-2.5 max-w-full [overflow-anchor:auto]", className)}
        data-testid="image-presentation"
        data-image-status={status}
        data-is-tall={isTall ? 'true' : 'false'}
      >
        {/* 失败或重试中原位占位卡片 */}
        {(status === 'error' || status === 'retrying') && (
          <div
            className="image-error-card flex flex-col gap-2 px-4 py-3 bg-vermilion-subtle border border-vermilion/30 rounded-sm my-2 max-w-[480px]"
            data-testid="image-error-card"
            aria-live="polite"
            {...searchIgnoreProps}
          >
            <div className="image-error-header flex items-center gap-2">
              <span className="image-error-badge inline-flex items-center justify-center size-4 rounded-full bg-vermilion text-ink-inverse text-[11px] font-bold leading-none shrink-0">!</span>
              <span className="image-error-title text-[13px] font-semibold text-vermilion">{IMAGE_COPY.loadFailed}</span>
            </div>
            <div className="image-error-url-row flex items-center flex-wrap gap-1.5 text-[11px] font-mono text-ink-secondary">
              {domain && <span className="image-error-domain font-semibold text-ink-primary bg-black/4 px-1.5 py-px rounded-sm">{domain}</span>}
              <span className="image-error-path text-ink-tertiary [word-break:break-all]" title={src}>
                {path}
              </span>
            </div>
            <div className="image-error-actions flex items-center mt-0.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="image-retry-btn h-auto px-3 py-0.5 rounded-sm font-semibold text-xs text-vermilion border-vermilion bg-surface-raised hover:bg-vermilion hover:text-ink-inverse focus-visible:outline-2 focus-visible:outline-vermilion focus-visible:outline-offset-1 disabled:opacity-60 disabled:cursor-not-allowed shadow-none"
                data-testid="image-retry-btn"
                disabled={status === 'retrying'}
                aria-label={IMAGE_COPY.retryAria(alt || domain)}
                onClick={handleRetry}
              >
                {status === 'retrying' ? IMAGE_COPY.retrying : IMAGE_COPY.retry}
              </Button>
            </div>
          </div>
        )}

        {/* 缩略图主容器：限高半屏，超长底部渐隐，键盘 Enter/空格或点击可打开大图 */}
        <div
          ref={triggerContainerRef}
          tabIndex={status === 'loaded' ? 0 : -1}
          role={status === 'loaded' ? 'button' : undefined}
          aria-label={status === 'loaded' ? IMAGE_COPY.openViewerAria(alt) : undefined}
          className={cn(
            "image-thumbnail-box relative inline-block max-w-full max-h-[min(50vh,480px)] overflow-hidden rounded-sm border border-transparent cursor-pointer transition-colors duration-150 bg-sheet-bg hover:border-ink-secondary hover:shadow-[0_2px_10px_rgba(0,0,0,0.07)] focus-visible:outline-2 focus-visible:outline-prussian-blue focus-visible:outline-offset-2 focus-visible:border-prussian-blue",
            status === 'loading' && "is-loading min-h-[120px] min-w-[180px] bg-black/[0.02] border-dashed border-sheet-border",
            status === 'loaded' && "is-loaded",
            (status === 'error' || status === 'retrying') && "is-hidden-media absolute size-[1px] p-0 -m-[1px] overflow-hidden [clip:rect(0,0,0,0)] whitespace-nowrap border-0 opacity-0 pointer-events-none",
            isTall && "is-tall block w-fit"
          )}
          data-testid="image-thumbnail-box"
          onClick={handleOpenViewer}
          onKeyDown={handleKeyDown}
        >
          {/* 加载中无转圈占位 */}
          {status === 'loading' && (
            <div className="image-loading-placeholder w-full h-full min-h-[120px] min-w-[180px]" data-testid="image-loading-placeholder" />
          )}

          {/* 真实 <img>：原生 URL，loading="lazy" 与 decoding="async" */}
          {/* 重试时容器处于视觉隐藏态，lazy 图片可能永远等不到进入视口，重试改为立即加载 */}
          <img
            key={`${src}-${loadAttempts}`}
            src={src}
            alt={alt}
            title={title}
            loading={loadAttempts > 0 ? 'eager' : 'lazy'}
            decoding="async"
            className={cn(
              "image-thumbnail-img block max-w-full h-auto object-contain object-top rounded-sm !m-0",
              isTall ? "max-h-none" : "max-h-[min(50vh,480px)]"
            )}
            data-testid="image-thumbnail-img"
            onLoad={handleLoad}
            onError={handleError}
          />

          {/* 超长竖图：底部渐隐与「长图」标记 */}
          {status === 'loaded' && isTall && (
            <div
              className="image-tall-fade absolute bottom-0 left-0 right-0 h-[76px] flex items-end justify-center pb-2 pointer-events-none bg-gradient-to-b from-transparent via-[color-mix(in_srgb,var(--sheet-bg)_88%,transparent)] to-[var(--sheet-bg)]"
              data-testid="image-tall-fade"
              aria-hidden="true"
              {...searchIgnoreProps}
            >
              <span className="image-tall-badge inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-primary bg-white/95 border border-sheet-border px-2.5 py-[3px] rounded-sm shadow-sm tracking-[0.02em] pointer-events-auto" data-testid="image-tall-badge">
                <svg
                  className="tall-badge-icon text-prussian-blue shrink-0 size-3"
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 2v12M4 5l4-3 4 3M4 11l4 3 4-3" />
                </svg>
                <span>{IMAGE_COPY.tallBadgeFull}</span>
              </span>
            </div>
          )}
        </div>

        {/* 看原图浮层 */}
        {viewerOpen && (
          <ImageViewerModal src={src} alt={alt} onClose={handleCloseViewer} returnFocus={triggerContainerRef} />
        )}
      </div>
    );
  }
);

ImagePresentation.displayName = 'ImagePresentation';
