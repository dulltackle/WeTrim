import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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
 * 查看完整原图浮层组件
 */
interface ImageViewerModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

const ImageViewerModal: React.FC<ImageViewerModalProps> = ({ src, alt, onClose }) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // 原生 showModal()：浏览器负责把焦点限制在浮层内、让背后页面 inert，与其余对话框一致
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    closeBtnRef.current?.focus();
  }, []);

  // 先关闭模态、解除背后页面的 inert，再交给 onClose 卸载并把焦点还给缩略图；顺序反了焦点会落空
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) {
      close();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer-overlay"
      data-testid="image-viewer-overlay"
      aria-label={IMAGE_COPY.viewerTitle}
      {...searchIgnoreProps}
      onCancel={(e) => {
        // Esc：阻止浏览器自行关闭，走同一条关闭路径
        e.preventDefault();
        close();
      }}
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
          onClick={close}
        >
          {IMAGE_COPY.viewerClose}
        </button>
      </div>
      <div className="image-viewer-body" onClick={handleBackdropClick}>
        <img
          src={src}
          alt={alt || IMAGE_COPY.defaultImageAlt}
          className="image-viewer-full-img"
          data-testid="image-viewer-full-img"
        />
      </div>
    </dialog>
  );
};

/**
 * 依据 Issue #30 与设计简报：
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
      triggerContainerRef.current?.focus();
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
            aria-live="polite"
            {...searchIgnoreProps}
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
          {/* 重试时容器处于视觉隐藏态，lazy 图片可能永远等不到进入视口，重试改为立即加载 */}
          <img
            key={`${src}-${loadAttempts}`}
            src={src}
            alt={alt}
            title={title}
            loading={loadAttempts > 0 ? 'eager' : 'lazy'}
            decoding="async"
            className="image-thumbnail-img"
            data-testid="image-thumbnail-img"
            onLoad={handleLoad}
            onError={handleError}
          />

          {/* 超长竖图：底部渐隐与「长图」标记 */}
          {status === 'loaded' && isTall && (
            <div
              className="image-tall-fade"
              data-testid="image-tall-fade"
              aria-hidden="true"
              {...searchIgnoreProps}
            >
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
