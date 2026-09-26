import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { IMAGE_COPY } from '../copy/image-presentation';

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
 * 查看完整原图浮层组件
 */
interface ImageViewerModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

const ImageViewerModal: React.FC<ImageViewerModalProps> = ({ src, alt, onClose }) => {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="image-viewer-overlay"
      data-testid="image-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={IMAGE_COPY.viewerTitle}
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div className="image-viewer-toolbar">
        <span className="image-viewer-title">{alt || IMAGE_COPY.viewerTitle}</span>
        <button
          ref={closeBtnRef}
          type="button"
          className="image-viewer-close-btn"
          data-testid="image-viewer-close-btn"
          aria-label={IMAGE_COPY.viewerCloseAria}
          onClick={onClose}
        >
          {IMAGE_COPY.viewerClose}
        </button>
      </div>
      <div className="image-viewer-body" onClick={handleBackdropClick}>
        <img
          src={src}
          alt={alt}
          className="image-viewer-full-img"
          data-testid="image-viewer-full-img"
        />
      </div>
    </div>
  );
};

/**
 * 依据 Issue #30 与设计简报：
 * 清洗页专用的图片呈现层：
 * - 正常时直接把图片资源的远程 URL 放进 <img src> 显示缩略图；清洗期不 fetch 图片字节
 * - 限高缩略图：保留态下图片在版心内按原比例显示，限最大高度（约半屏，min(50vh, 480px)）
 * - 超长竖图：只显示顶部，底部加渐隐与「长图」标记
 * - 查看原图：点击缩略图或聚焦后按回车，在浮层中看完整原图；Esc 关闭，焦点平稳回到原缩略图
 * - 图片失败：原位占位，写明「图片没有加载出来」，附域名与截短的地址，加「重试」按钮
 * - 重试只重新设置 DOM 上的 src，不改 Markdown 里保存的地址
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
    const imgRef = useRef<HTMLImageElement | null>(null);

    const { domain, path } = formatImageErrorUrl(src);

    // 图片加载成功
    const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setStatus('loaded');

      // 判定是否为超长竖图：高宽比大于 1.8，或高度超出限制并被裁切
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const ratio = img.naturalHeight / img.naturalWidth;
        const reachedMaxHeight = img.clientHeight >= 340 && img.naturalHeight > img.clientHeight * 1.25;
        if (ratio > 1.8 || reachedMaxHeight) {
          setIsTall(true);
        } else {
          setIsTall(false);
        }
      }
    }, []);

    // 图片加载失败
    const handleError = useCallback(() => {
      setStatus('error');
    }, []);

    // 点击重试：只重设 DOM 上的 src，不改动 Markdown 保存的地址
    const handleRetry = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        setStatus('retrying');
        setLoadAttempts((c) => c + 1);

        if (imgRef.current) {
          const currentUrl = src;
          // 重新设置 src
          imgRef.current.src = '';
          imgRef.current.src = currentUrl;
        }
      },
      [src]
    );

    // 打开全图浮层
    const handleOpenViewer = useCallback(() => {
      if (status === 'loaded') {
        setViewerOpen(true);
      }
    }, [status]);

    // 关闭全图浮层并恢复焦点至缩略图
    const handleCloseViewer = useCallback(() => {
      setViewerOpen(false);
      triggerContainerRef.current?.focus();
    }, []);

    const prevViewerOpenRef = useRef(false);
    useEffect(() => {
      if (prevViewerOpenRef.current && !viewerOpen) {
        triggerContainerRef.current?.focus();
      }
      prevViewerOpenRef.current = viewerOpen;
    }, [viewerOpen]);

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
        className={`image-presentation-block ${className}`}
        data-testid="image-presentation"
        data-image-status={status}
        data-is-tall={isTall ? 'true' : 'false'}
      >
        {/* 失败或重试中原位占位卡片 */}
        {(status === 'error' || status === 'retrying') && (
          <div
            className="image-error-card"
            data-testid="image-error-card"
            role="alert"
            aria-live="polite"
          >
            <div className="image-error-header">
              <span className="image-error-badge">!</span>
              <span className="image-error-title">{IMAGE_COPY.loadFailed}</span>
            </div>
            <div className="image-error-url-row">
              {domain && <span className="image-error-domain">{domain}</span>}
              <span className="image-error-path" title={src}>
                {path}
              </span>
            </div>
            <div className="image-error-actions">
              <button
                type="button"
                className="image-retry-btn"
                data-testid="image-retry-btn"
                disabled={status === 'retrying'}
                aria-label={IMAGE_COPY.retryAria(alt || domain)}
                onClick={handleRetry}
              >
                {status === 'retrying' ? IMAGE_COPY.retrying : IMAGE_COPY.retry}
              </button>
            </div>
          </div>
        )}

        {/* 缩略图主容器：限高半屏，超长底部渐隐，键盘 Enter/空格或点击可打开大图 */}
        <div
          ref={triggerContainerRef}
          tabIndex={status === 'loaded' ? 0 : -1}
          role={status === 'loaded' ? 'button' : undefined}
          aria-label={status === 'loaded' ? IMAGE_COPY.openViewerAria(alt) : undefined}
          className={`image-thumbnail-box ${status === 'loading' ? 'is-loading' : ''} ${
            status === 'loaded' ? 'is-loaded' : ''
          } ${status === 'error' || status === 'retrying' ? 'is-hidden-media' : ''} ${
            isTall ? 'is-tall' : ''
          }`}
          data-testid="image-thumbnail-box"
          onClick={handleOpenViewer}
          onKeyDown={handleKeyDown}
        >
          {/* 加载中无转圈占位 */}
          {status === 'loading' && (
            <div className="image-loading-placeholder" data-testid="image-loading-placeholder" />
          )}

          {/* 真实 <img>：原生 URL，loading="lazy" 与 decoding="async" */}
          <img
            key={`${src}-${loadAttempts}`}
            ref={imgRef}
            src={src}
            alt={alt}
            title={title}
            loading="lazy"
            decoding="async"
            className="image-thumbnail-img"
            data-testid="image-thumbnail-img"
            onLoad={handleLoad}
            onError={handleError}
          />

          {/* 超长竖图：底部渐隐与「长图」标记 */}
          {status === 'loaded' && isTall && (
            <div className="image-tall-fade" data-testid="image-tall-fade" aria-hidden="true">
              <span className="image-tall-badge" data-testid="image-tall-badge">
                <svg
                  className="tall-badge-icon"
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
          <ImageViewerModal src={src} alt={alt} onClose={handleCloseViewer} />
        )}
      </div>
    );
  }
);

ImagePresentation.displayName = 'ImagePresentation';
