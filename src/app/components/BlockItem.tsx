import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { currentMarkdown, type Block } from '../../shared/types';
import { truncateGraphemes } from '../../shared/grapheme';
import { renderMarkdown } from '../preview/render';
import { renderHtmlWithImages } from '../preview/html-to-react';
import { IMAGE_COPY, NOTES_COPY } from '../copy/image-presentation';
import { BLOCK_COPY } from '../copy/block';
import { SEARCH_IGNORE_ATTR } from '../search/text-search';

export interface BlockItemProps {
  imageSelection?: { start: number; end: number };
  block: Block;
  isEditing: boolean;
  onStartEdit: (id: string) => void;
  onFinishEdit: (id: string) => void;
  onToggle: (id: string) => void;
  onUpdate?: (id: string, editedMarkdown: string | null) => void;
  isTempExpanded?: boolean;
  /** 登记本块的「立即提交未保存编辑」函数，供外部（如打开检查结果前）统一刷新；传 null 表示注销 */
  registerFlush?: (id: string, flush: ((finishEditing?: boolean) => void) | null) => void;
}

const NOTE_MARKER_CODE_CLASSES: Record<string, string> = {
  'table-degraded': 'bg-amber-subtle border-amber/45 text-amber-ink',
  'richmedia-placeholder': 'bg-prussian-blue-subtle border-prussian-blue/35 text-prussian-blue',
  'convert-failed': 'bg-vermilion-subtle border-vermilion/35 text-vermilion',
};

const NOTE_CARD_CODE_CLASSES: Record<string, { card: string; badge: string }> = {
  'table-degraded': {
    card: 'bg-amber-subtle border-amber/35 text-ink-primary',
    badge: 'bg-amber text-ink-primary',
  },
  'richmedia-placeholder': {
    card: 'bg-prussian-blue-subtle border-prussian-blue/25 text-ink-primary',
    badge: 'bg-prussian-blue text-ink-inverse',
  },
  'convert-failed': {
    card: 'bg-vermilion-subtle border-vermilion/25 text-ink-primary',
    badge: 'bg-vermilion text-ink-inverse',
  },
};

const HEADING_EDITOR_FONT_CLASS: Record<number, string> = {
  1: 'text-[20px]',
  2: 'text-[18px]',
  3: 'text-[16px]',
};

/**
 * 依据 Issue #24, #25, #27, #30, #73 & 设计简报：
 * - 默认真实阅读态：renderMarkdown 渲染 currentMarkdown(block)
 * - 所有块都可编辑：点击「编辑 Markdown」原地展开源码 <textarea>，初始类型与切块不改变
 * - 空字符串 '' 是有效编辑，用 ?? 不用 ||，不回退到初始内容
 * - 防抖 500ms + 从首次未落盘修改起最长 2s 硬上限必须发起写入
 * - 实时反馈 ≤50ms：编辑中徽章（已修改 / 内容为空）基于本地值同步即时更新
 * - 还原内容：单块编辑区与常驻 meta 操作行均提供，二次内联确认，不改动保留/剔除状态
 * - 纯键盘可达与焦点保持：完成编辑后焦点平稳回落该块，不跳顶
 * - 临时展开（isTempExpanded）：搜索命中折叠剔除块时临时展开，离开后自动收起
 * - 编辑器随输入调整高度，固定字号使用静态映射，运行时高度通过 CSS 变量 --editor-height 消费
 */
export const BlockItem = memo(
  forwardRef<HTMLDivElement, BlockItemProps>(({ block, isEditing, onStartEdit, onFinishEdit, onToggle, onUpdate, isTempExpanded, registerFlush, imageSelection }, ref) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isConfirmingRestore, setIsConfirmingRestore] = useState(false);
    const [localValue, setLocalValue] = useState(() => currentMarkdown(block));

    const itemContainerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const localValueRef = useRef(localValue);
    localValueRef.current = localValue;

    const isDirtyRef = useRef(false);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const prevEditedMarkdownRef = useRef(block.editedMarkdown);

    // 合并 forwarded ref 与内部 container ref
    const setRefs = useCallback(
      (el: HTMLDivElement | null) => {
        itemContainerRef.current = el;
        if (typeof ref === 'function') {
          ref(el);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      },
      [ref]
    );

    // 提交当前修改
    const flushSave = useCallback(() => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (maxWaitTimerRef.current) {
        clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      if (isDirtyRef.current) {
        isDirtyRef.current = false;
        onUpdate?.(block.id, localValueRef.current);
      }
    }, [block.id, onUpdate]);

    // 外部 block props 同步：当外部 block.editedMarkdown 变更（如还原成功，或外部更新）
    // 且本地无未保存修改时同步。BlockList 以 block.id 作为 key，id 变化必然导致
    // 组件卸载重建，因此这里无需处理块身份变更的场景。
    useEffect(() => {
      if (block.editedMarkdown !== prevEditedMarkdownRef.current && !isDirtyRef.current) {
        const newMd = currentMarkdown(block);
        setLocalValue(newMd);
        localValueRef.current = newMd;
      }
      prevEditedMarkdownRef.current = block.editedMarkdown;
    }, [block.id, block.editedMarkdown, block.initialMarkdown]);

    // 当外部重新包含该块时，若处于折叠态则重置
    useEffect(() => {
      if (block.included) {
        setIsExpanded(false);
      }
    }, [block.included]);

    // 向列表登记提交函数：检查结果等需要读取当前内存内容的操作，先让防抖中的编辑落入快照
    useEffect(() => {
      if (!registerFlush) return;
      registerFlush(block.id, (finishEditing) => {
        flushSave();
        if (finishEditing && isEditing) {
          onFinishEdit(block.id);
          setIsConfirmingRestore(false);
        }
      });
      return () => registerFlush(block.id, null);
    }, [block.id, flushSave, registerFlush, isEditing, onFinishEdit]);

    // 卸载前刷新未保存更改
    useEffect(() => {
      return () => {
        flushSave();
      };
    }, [flushSave]);

    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      if (!isEditing || !textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditing]);

    useLayoutEffect(() => {
      if (!imageSelection) return;
      setIsExpanded(true);
      setIsConfirmingRestore(false);
    }, [imageSelection]);
    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      if (!imageSelection || !isEditing || !textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(imageSelection.start, imageSelection.end);
      itemContainerRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }, [imageSelection, isEditing, isExpanded]);

    // 编辑区随内容自动增高：运行时高度通过 CSS 变量 --editor-height 消费
    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (isEditing && el) {
        el.style.height = 'auto';
        const scrollH = el.scrollHeight;
        el.style.height = `${scrollH}px`;
        el.style.setProperty('--editor-height', `${scrollH}px`);
      }
    }, [isEditing, localValue, isExpanded]);

    // 文本框输入事件
    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextVal = e.target.value;
      setLocalValue(nextVal);
      localValueRef.current = nextVal;
      isDirtyRef.current = true;

      // 重置 500ms 防抖定时器
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        flushSave();
      }, 500);

      // 首次未保存修改起最长 2s 硬上限定时器
      if (!maxWaitTimerRef.current) {
        maxWaitTimerRef.current = setTimeout(() => {
          flushSave();
        }, 2000);
      }
    };

    // 进入编辑态
    const handleStartEdit = () => {
      if (!block.included && !isExpanded) {
        setIsExpanded(true);
      }
      onStartEdit(block.id);
      setIsConfirmingRestore(false);
    };

    const handleContentDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      if (isEditing || !(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(`[${SEARCH_IGNORE_ATTR}], button, input, [role="button"], dialog`)) return;
      const content = target.closest('.block-rendered-content, .block-empty-placeholder');
      if (!content || !event.currentTarget.contains(content)) return;
      if (!content.classList.contains('block-empty-placeholder')) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim() ||
            !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return;
      }
      handleStartEdit();
    };

    // 完成编辑
    const handleFinishEdit = () => {
      flushSave();
      onFinishEdit(block.id);
      setIsConfirmingRestore(false);
      setTimeout(() => {
        itemContainerRef.current?.focus();
      }, 0);
    };

    // 启动还原确认
    const handleStartRestore = () => {
      setIsConfirmingRestore(true);
    };

    // 取消还原
    const handleCancelRestore = () => {
      setIsConfirmingRestore(false);
    };

    // 确认还原：恢复初始内容并丢弃当前编辑，不改变保留或剔除状态
    const handleConfirmRestore = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (maxWaitTimerRef.current) {
        clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      isDirtyRef.current = false;
      setLocalValue(block.initialMarkdown);
      localValueRef.current = block.initialMarkdown;
      setIsConfirmingRestore(false);
      onFinishEdit(block.id);
      onUpdate?.(block.id, null);
      setTimeout(() => {
        itemContainerRef.current?.focus();
      }, 0);
    };

    const handleToggle = () => {
      onToggle(block.id);
    };

    // 正文链接是待清洗内容。保留地址与事件传播，只取消导航；捕获阶段也覆盖图片内停止冒泡的操作。
    const handleContentLinkClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('.block-rendered-content a[href]');
      if (link && event.currentTarget.contains(link)) {
        event.preventDefault();
      }
    };

    const typeLabel: string = BLOCK_COPY.typeLabels[block.type] ?? block.type;
    const levelText =
      block.type === 'heading' && block.headingLevel ? ` H${block.headingLevel}` : '';

    // 编辑区字号与字体随块类型贴近渲染态量级，避免切入编辑态时排版骤降或字形跳跃
    const editorFontClass = cn(
      block.type === 'heading'
        ? HEADING_EDITOR_FONT_CLASS[block.headingLevel ?? 0] ?? 'text-[15px]'
        : 'text-[15px]',
      block.type === 'code' ? 'font-mono' : 'font-sans'
    );

    // 实时状态计算：在编辑态下以 localValue 为准，阅读态以 currentMarkdown 为准
    const effectiveMarkdown = isEditing ? localValue : currentMarkdown(block);
    const isLocallyEmpty = effectiveMarkdown.trim() === '';
    const isLocallyEdited =
      block.editedMarkdown !== null || (isEditing && localValue !== block.initialMarkdown);

    // 列表、引用、表格为整体块，展示操作提示
    const isComposite = block.type === 'list' || block.type === 'quote' || block.type === 'table';

    const previewText = useMemo(() => truncateGraphemes(effectiveMarkdown, 20), [effectiveMarkdown]);
    const summaryPreview = isLocallyEmpty ? BLOCK_COPY.emptyContent : previewText;

    const isCollapsed = !block.included && !isExpanded && !isTempExpanded;

    // 展开态渲染内容缓存：顶层 Hook 调用，折叠态跳过渲染，非折叠态缓存 marked 解析结果
    const renderedHtml = useMemo(
      () => (!isLocallyEmpty && !isCollapsed ? renderMarkdown(effectiveMarkdown) : ''),
      [isLocallyEmpty, isCollapsed, effectiveMarkdown]
    );
    // 含图片时要经 DOMParser 转成 React 树，同样按渲染结果缓存
    const renderedNode = useMemo(() => renderHtmlWithImages(renderedHtml), [renderedHtml]);

    // 图片块元数据解析：折叠态显示行高小缩略图与 alt 文案
    const imageInfo = useMemo(() => {
      if (block.type !== 'image') return null;
      const md = effectiveMarkdown.trim();
      const mdMatch = md.match(/!\[(.*?)\]\((.*?)(?:\s+"(.*?)")?\)/);
      if (mdMatch) {
        return { alt: mdMatch[1] || '', src: mdMatch[2] || '' };
      }
      const htmlMatch = md.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i);
      if (htmlMatch) {
        const altMatch = md.match(/alt=["']([^"']*)["']/i);
        return { alt: altMatch ? altMatch[1] : '', src: htmlMatch[1] || '' };
      }
      return null;
    }, [block.type, effectiveMarkdown]);

    // 折叠态小缩略图加载失败时退回只显示替代文字，不露出浏览器的破图图标；记下失败的地址，换图后自然复位
    const [failedCollapsedThumbSrc, setFailedCollapsedThumbSrc] = useState<string | null>(null);

    // 页边批注栏短标记：折叠态与展开态共用
    const marginNoteMarkers =
      block.notes.length > 0 ? (
        <div
          className="block-margin-note-markers absolute top-2.5 right-[calc(100%+60px)] flex flex-col items-end gap-1 pointer-events-auto z-10 max-[720px]:static max-[720px]:flex-row max-[720px]:flex-wrap max-[720px]:items-center max-[720px]:gap-1.5 max-[720px]:mt-1 max-[720px]:mb-0.5"
          data-testid="block-margin-note-markers"
          aria-hidden="true"
        >
          {block.notes.map((note, idx) => (
            <span
              key={`${note.code}-${idx}`}
              className={cn(
                "margin-note-marker border text-[11px] font-semibold px-1.5 py-[1px] rounded-sm leading-[1.4] whitespace-nowrap tracking-[0.02em] shadow-xs",
                `marker-code-${note.code}`,
                NOTE_MARKER_CODE_CLASSES[note.code] ?? 'bg-surface-muted border-sheet-border text-ink-secondary'
              )}
              title={note.message}
              data-note-code={note.code}
            >
              {NOTES_COPY.shortBadges[note.code] || NOTES_COPY.shortBadges.fallback}
            </span>
          ))}
        </div>
      ) : null;

    // 整体块提示图标与浮层
    const compositeTip = isComposite ? (
      <span
        className="composite-block-tip-trigger relative inline-flex items-center justify-center text-ink-tertiary hover:text-prussian-blue focus-visible:text-prussian-blue focus-visible:outline-1 focus-visible:outline-prussian-blue cursor-help min-w-[24px] min-h-[24px] -my-1 -mx-0.5 rounded-sm group"
        data-testid="composite-block-tip"
        tabIndex={0}
        role="img"
        aria-label={BLOCK_COPY.compositeTip}
      >
        <svg
          className="tip-icon block size-[13px]"
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" />
          <line x1="8" y1="7.5" x2="8" y2="11.5" />
          <circle cx="8" cy="4.75" r="0.5" fill="currentColor" />
        </svg>
        {/* 可见浮层只给视觉用户；读屏已经从 aria-label 读到同一句，避免重复朗读 */}
        <span
          className="tip-tooltip absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 bg-ink-primary text-ink-inverse text-[11px] leading-tight px-2 py-1 rounded-sm whitespace-nowrap pointer-events-none opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus:opacity-100 group-focus:visible group-focus-visible:opacity-100 group-focus-visible:visible transition-all duration-150 z-30 shadow-md after:content-[''] after:absolute after:top-full after:left-1/2 after:-translate-x-1/2 after:border-4 after:border-solid after:border-[var(--ink-primary)_transparent_transparent_transparent]"
          aria-hidden="true"
        >
          {BLOCK_COPY.compositeTip}
        </span>
      </span>
    ) : null;

    // 内联二次确认条
    const inlineRestoreConfirm = (
      <div className="restore-confirm-inline inline-flex items-center gap-1.5 px-2 py-0.5 bg-amber-subtle border border-amber-border rounded-sm" data-testid="restore-confirm-inline">
        <span className="restore-confirm-tip text-[11px] text-amber-ink font-medium whitespace-nowrap">
          {BLOCK_COPY.restoreConfirmTip}
        </span>
        <Button
          type="button"
          size="sm"
          className="block-action-btn block-action-confirm-restore h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-semibold text-ink-inverse bg-vermilion border border-vermilion hover:bg-vermilion-strong hover:border-vermilion-strong shadow-none"
          data-testid="block-action-confirm-restore"
          aria-label={BLOCK_COPY.confirmRestoreAria(block.order)}
          onClick={handleConfirmRestore}
        >
          {BLOCK_COPY.confirmRestore}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="block-action-btn block-action-cancel-restore h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-normal text-ink-secondary bg-surface-raised border-sheet-border hover:bg-surface-muted hover:text-ink-primary shadow-none"
          data-testid="block-action-cancel-restore"
          aria-label={BLOCK_COPY.cancelRestoreAria(block.order)}
          onClick={handleCancelRestore}
        >
          {BLOCK_COPY.cancelRestore}
        </Button>
      </div>
    );

    // 折叠摘要态（剔除且未展开）
    if (isCollapsed) {
      return (
        <div
          ref={setRefs}
          tabIndex={-1}
          className={cn(
            "block-item block-excluded block-collapsed relative block w-full min-w-0 [contain:inline-size_layout_style] [scroll-margin-top:0] rounded-sm transition-colors duration-150 px-3.5 py-1.5 opacity-85 bg-sheet-bg border border-sheet-border hover:border-ink-secondary focus:outline-none focus-visible:outline-2 focus-visible:outline-prussian-blue focus-visible:outline-offset-1",
            isLocallyEdited && "block-is-edited",
            isLocallyEmpty && "block-is-empty border-dashed"
          )}
          data-testid="block-item"
          data-block-id={block.id}
          data-block-type={block.type}
          data-block-order={block.order}
          data-block-included="false"
          data-block-edited={isLocallyEdited ? 'true' : 'false'}
          data-block-empty={isLocallyEmpty ? 'true' : 'false'}
          data-block-collapsed="true"
          data-block-editing="false"
          aria-describedby={block.notes.length > 0 ? `block-notes-${block.id}` : undefined}
        >
          {/* 折叠态页边批注栏短标记保留（Issue #30 设计简报 §3） */}
          {marginNoteMarkers}

          {/* 折叠态无障碍转换提示文本（供 aria-describedby 读屏技术关联） */}
          {block.notes.length > 0 && (
            <div
              id={`block-notes-${block.id}`}
              className="sr-only"
              data-testid="block-notes-sr"
            >
              {block.notes.map((note) => note.message).join('；')}
            </div>
          )}

          <div className="block-item-meta block-collapsed-summary-bar flex items-center gap-2 w-full min-w-0 text-[11px]">
            <span className="block-order-badge font-mono font-semibold text-ink-tertiary min-w-[32px]" data-testid="block-order-badge">
              #{block.order}
            </span>
            <span
              className={cn(
                "block-type-badge text-xs font-semibold px-1.5 py-[1px] rounded-sm border border-sheet-border bg-surface-muted text-ink-secondary",
                `block-type-${block.type}`,
                block.type === 'unknown' && "border-dashed"
              )}
              data-testid="block-type-badge"
            >
              {typeLabel}
              {levelText}
            </span>
            {compositeTip}
            {isLocallyEdited && (
              <span className="block-edited-badge text-[11px] font-semibold px-1.5 py-[1px] rounded-sm bg-amber-subtle text-amber-ink border border-amber-border font-mono" data-testid="block-edited-badge">
                {BLOCK_COPY.editedBadge}
              </span>
            )}
            {isLocallyEmpty && (
              <span className="block-empty-badge text-[11px] font-medium px-1.5 py-[1px] rounded-sm bg-surface-muted text-ink-secondary border border-sheet-border font-mono" data-testid="block-empty-badge">
                {BLOCK_COPY.emptyBadge}
              </span>
            )}
            <span
              className="block-status-tag status-excluded ml-auto text-[11px] font-mono text-vermilion font-semibold"
              data-testid="block-status-tag"
            >
              {BLOCK_COPY.statusExcluded}
            </span>

            {/* 折叠摘要带小图（Issue #30 设计简报 §3）：剔除折叠图片块放行高小图与 alt */}
            {block.type === 'image' && imageInfo?.src ? (
              <span
                className="block-summary-image-preview inline-flex items-center gap-2 min-w-0 flex-1 overflow-hidden"
                data-testid="block-summary-image-preview"
              >
                {failedCollapsedThumbSrc !== imageInfo.src && (
                  <img
                    src={imageInfo.src}
                    alt={imageInfo.alt || IMAGE_COPY.defaultImageAlt}
                    className="block-collapsed-thumb size-[22px] object-cover rounded-sm border border-sheet-border bg-sheet-bg shrink-0 m-0"
                    data-testid="block-collapsed-thumb"
                    loading="lazy"
                    decoding="async"
                    onError={() => setFailedCollapsedThumbSrc(imageInfo.src)}
                  />
                )}
                <span className="block-collapsed-alt text-xs text-ink-secondary overflow-hidden text-ellipsis whitespace-nowrap" data-testid="block-collapsed-alt">
                  {imageInfo.alt || IMAGE_COPY.defaultImageAlt}
                </span>
              </span>
            ) : (
              <span className="block-summary-preview flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-secondary px-1" data-testid="block-summary-preview">
                {summaryPreview}
              </span>
            )}

            <div className="block-item-actions flex items-center gap-1.5 ml-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-toggle-btn block-action-restore h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-semibold text-prussian-blue border-prussian-blue-border bg-prussian-blue-subtle hover:bg-prussian-blue-subtle-hover hover:text-prussian-blue-strong hover:border-prussian-blue shadow-none"
                data-testid="block-action-restore"
                aria-label={BLOCK_COPY.restoreIncludedAria(block.order)}
                onClick={handleToggle}
              >
                {BLOCK_COPY.restoreIncluded}
              </Button>

              {isLocallyEdited && (
                isConfirmingRestore ? (
                  inlineRestoreConfirm
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="block-action-btn block-action-restore-content h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-vermilion bg-vermilion-subtle border border-vermilion-border hover:bg-vermilion-subtle-hover hover:text-vermilion-strong hover:border-vermilion shadow-none"
                    data-testid="block-action-restore-content"
                    aria-label={BLOCK_COPY.restoreContentAria(block.order)}
                    onClick={handleStartRestore}
                  >
                    {BLOCK_COPY.restoreContent}
                  </Button>
                )
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-action-btn block-action-expand h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-ink-secondary bg-surface-muted hover:bg-surface-hover hover:text-ink-primary border-sheet-border shadow-none"
                data-testid="block-action-expand"
                aria-label={BLOCK_COPY.expandAria(block.order)}
                onClick={() => setIsExpanded(true)}
              >
                {BLOCK_COPY.expand}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-action-btn block-action-edit h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-ink-secondary bg-surface-muted hover:bg-surface-hover hover:text-ink-primary hover:border-ink-secondary border-sheet-border shadow-none"
                data-testid="block-action-edit"
                aria-label={BLOCK_COPY.editAria(block.order)}
                onClick={handleStartEdit}
              >
                {BLOCK_COPY.edit}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // 展开态（保留态，或剔除后点击展开 / 编辑）
    let contentNode: React.ReactNode;
    if (isEditing) {
      contentNode = (
        <div className="block-editor flex flex-col gap-2 mt-1.5 w-full" data-testid="block-editor">
          <textarea
            ref={textareaRef}
            className={cn(
              "block-editor-textarea w-full min-h-[80px] max-h-[600px] overflow-y-auto px-3 py-2 border border-sheet-border rounded-sm bg-sheet-bg text-ink-primary leading-[1.75] resize-y box-border transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-prussian-blue focus:border-prussian-blue focus:bg-surface-raised h-[var(--editor-height,auto)]",
              editorFontClass
            )}
            data-testid="block-editor-textarea"
            value={localValue}
            onChange={handleTextareaChange}
            aria-label={BLOCK_COPY.editAria(block.order)}
            autoFocus
          />
          <div className="block-editor-toolbar flex items-center justify-end gap-2 pt-0.5" data-testid="block-editor-toolbar">
            {isLocallyEdited && !isConfirmingRestore && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-action-btn block-action-restore-content h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-vermilion bg-vermilion-subtle border border-vermilion-border hover:bg-vermilion-subtle-hover hover:text-vermilion-strong hover:border-vermilion shadow-none"
                data-testid="block-action-restore-content"
                aria-label={BLOCK_COPY.restoreContentAria(block.order)}
                onClick={handleStartRestore}
              >
                {BLOCK_COPY.restoreContent}
              </Button>
            )}
            {isConfirmingRestore && inlineRestoreConfirm}
            <Button
              type="button"
              variant="default"
              size="sm"
              className="block-action-btn block-action-finish-edit h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-semibold bg-prussian-blue text-ink-inverse hover:bg-prussian-blue-strong border-prussian-blue shadow-none"
              data-testid="block-action-finish-edit"
              aria-label={BLOCK_COPY.finishEditAria(block.order)}
              onClick={handleFinishEdit}
            >
              {BLOCK_COPY.finishEdit}
            </Button>
          </div>
        </div>
      );
    } else if (isLocallyEmpty) {
      contentNode = (
        <div className="block-empty-placeholder text-[13px] text-ink-tertiary italic px-1 py-2 cursor-text" data-testid="block-empty-placeholder">
          {BLOCK_COPY.emptyContent}
        </div>
      );
    } else {
      contentNode = renderedNode;
    }

    return (
      <div
        ref={setRefs}
        tabIndex={-1}
        className={cn(
          "block-item relative block w-full min-w-0 [contain:inline-size_layout_style] [scroll-margin-top:0] rounded-sm transition-colors duration-150 px-3.5 py-2.5 focus:outline-none focus-visible:outline-2 focus-visible:outline-prussian-blue focus-visible:outline-offset-1 border border-sheet-border hover:border-ink-secondary",
          block.included ? "block-included bg-surface-raised" : "block-excluded block-expanded opacity-85 bg-sheet-bg",
          isLocallyEdited && "block-is-edited",
          isLocallyEmpty && "block-is-empty border-dashed",
          isEditing && "block-is-editing border-prussian-blue shadow-[0_1px_3px_color-mix(in_srgb,var(--prussian-blue)_8%,transparent)]"
        )}
        data-testid="block-item"
        data-block-id={block.id}
        data-block-type={block.type}
        data-block-order={block.order}
        data-block-included={block.included ? 'true' : 'false'}
        data-block-edited={isLocallyEdited ? 'true' : 'false'}
        data-block-empty={isLocallyEmpty ? 'true' : 'false'}
        data-block-collapsed="false"
        data-block-editing={isEditing ? 'true' : 'false'}
        onClickCapture={handleContentLinkClick}
        onAuxClickCapture={handleContentLinkClick}
        onDoubleClick={handleContentDoubleClick}
        aria-describedby={block.notes.length > 0 ? `block-notes-${block.id}` : undefined}
      >
        {/* 页边批注栏短标记（Issue #30 设计简报 §3）：桌面端在左侧批注栏对齐顶端，窄屏退回块内 */}
        {marginNoteMarkers}

        {/* 周边文字状态徽章与操作条 */}
        <div className="block-item-meta flex items-center gap-2 text-[11px] min-w-0">
          <span className="block-order-badge font-mono font-semibold text-ink-tertiary min-w-[32px]" data-testid="block-order-badge">
            #{block.order}
          </span>
          <span
            className={cn(
              "block-type-badge text-xs font-semibold px-1.5 py-[1px] rounded-sm border border-sheet-border bg-surface-muted text-ink-secondary",
              `block-type-${block.type}`,
              block.type === 'unknown' && "border-dashed"
            )}
            data-testid="block-type-badge"
          >
            {typeLabel}
            {levelText}
          </span>
          {compositeTip}
          {isLocallyEdited && (
            <span className="block-edited-badge text-[11px] font-semibold px-1.5 py-[1px] rounded-sm bg-amber-subtle text-amber-ink border border-amber-border font-mono" data-testid="block-edited-badge">
              {BLOCK_COPY.editedBadge}
            </span>
          )}
          {isLocallyEmpty && (
            <span className="block-empty-badge text-[11px] font-medium px-1.5 py-[1px] rounded-sm bg-surface-muted text-ink-secondary border border-sheet-border font-mono" data-testid="block-empty-badge">
              {BLOCK_COPY.emptyBadge}
            </span>
          )}
          <span
            className={cn(
              "block-status-tag ml-auto text-[11px] font-mono",
              block.included ? "status-included text-ok-ink font-semibold" : "status-excluded text-vermilion font-semibold"
            )}
            data-testid="block-status-tag"
          >
            {block.included ? BLOCK_COPY.statusIncluded : BLOCK_COPY.statusExcluded}
          </span>

          <div className="block-item-actions flex items-center gap-1.5 ml-auto">
            {block.included ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-toggle-btn block-action-exclude h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-ink-secondary bg-surface-raised border-sheet-border hover:text-vermilion hover:border-vermilion hover:bg-vermilion-subtle shadow-none"
                data-testid="block-action-exclude"
                aria-label={BLOCK_COPY.excludeAria(block.order)}
                onClick={handleToggle}
              >
                {BLOCK_COPY.exclude}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="block-toggle-btn block-action-restore h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-semibold text-prussian-blue border-prussian-blue-border bg-prussian-blue-subtle hover:bg-prussian-blue-subtle-hover hover:text-prussian-blue-strong hover:border-prussian-blue shadow-none"
                  data-testid="block-action-restore"
                  aria-label={BLOCK_COPY.restoreIncludedAria(block.order)}
                  onClick={handleToggle}
                >
                  {BLOCK_COPY.restoreIncluded}
                </Button>
                {!isEditing && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="block-action-btn block-action-collapse h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-ink-secondary bg-surface-muted hover:bg-surface-hover hover:text-ink-primary border-sheet-border shadow-none"
                    data-testid="block-action-collapse"
                    aria-label={BLOCK_COPY.collapseAria(block.order)}
                    onClick={() => setIsExpanded(false)}
                  >
                    {BLOCK_COPY.collapse}
                  </Button>
                )}
              </>
            )}

            {/* 还原入口：常驻 meta 操作行 */}
            {isLocallyEdited && (
              isConfirmingRestore ? (
                inlineRestoreConfirm
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="block-action-btn block-action-restore-content h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-vermilion bg-vermilion-subtle border border-vermilion-border hover:bg-vermilion-subtle-hover hover:text-vermilion-strong hover:border-vermilion shadow-none"
                  data-testid="block-action-restore-content"
                  aria-label={BLOCK_COPY.restoreContentAria(block.order)}
                  onClick={handleStartRestore}
                >
                  {BLOCK_COPY.restoreContent}
                </Button>
              )
            )}

            {/* 编辑入口：完成编辑按钮已在编辑区工具栏提供，此处编辑态下不重复渲染 */}
            {!isEditing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="block-action-btn block-action-edit h-auto min-h-[26px] px-2.5 py-[3px] rounded-sm text-xs font-medium text-ink-secondary bg-surface-muted hover:bg-surface-hover hover:text-ink-primary hover:border-ink-secondary border-sheet-border shadow-none"
                data-testid="block-action-edit"
                aria-label={BLOCK_COPY.editAria(block.order)}
                onClick={handleStartEdit}
              >
                {BLOCK_COPY.edit}
              </Button>
            )}
          </div>
        </div>

        {/* 块内展开的完整转换提示（Issue #30 设计简报 §3）：令牌化配色与 aria-describedby 关联 */}
        {block.notes.length > 0 && (
          <div
            id={`block-notes-${block.id}`}
            className="block-notes flex flex-col gap-1.5 my-1.5"
            data-testid="block-notes"
          >
            {block.notes.map((note, idx) => {
              const codeStyle = NOTE_CARD_CODE_CLASSES[note.code] ?? {
                card: 'bg-canvas-bg border-sheet-border text-ink-primary',
                badge: 'bg-black/8 text-ink-primary',
              };
              return (
                <div
                  key={`${note.code}-${idx}`}
                  id={`block-note-${block.id}-${idx}`}
                  className={cn(
                    "block-note flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-sm leading-normal border",
                    `note-code-${note.code}`,
                    codeStyle.card
                  )}
                >
                  <span className={cn("note-badge font-bold text-[11px] uppercase px-[5px] py-[1px] rounded-sm shrink-0", codeStyle.badge)}>
                    {NOTES_COPY.shortBadges[note.code] || NOTES_COPY.shortBadges.fallback}
                  </span>
                  <span className="note-message flex-1 min-w-0">{note.message}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 内容区：编辑态原地替换为 <textarea>，阅读态渲染语义 HTML */}
        {contentNode}
      </div>
    );
  })
);

BlockItem.displayName = 'BlockItem';
