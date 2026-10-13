import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArticleSnapshot, Block } from '../../shared/types';
import { currentMarkdown } from '../../shared/types';
import { buildFrontMatter, parseFrontMatterDate, stripBoundaryEmptyLines, type ResultFile } from '../export/build-markdown';
import { renderMarkdownToFragment } from '../preview/render';
import { renderFragmentWithImages } from '../preview/html-to-react';
import { truncateGraphemes } from '../../shared/grapheme';
import { PREVIEW_COPY } from '../copy/preview';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';
import { Button } from '@/components/ui/button';
import { DialogPortalContainer } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface DegradationItem {
  blockOrder: number;
  blockId: string;
  code: string;
  typeName: string;
  summary: string;
}

export interface PreviewDialogProps {
  isOpen: boolean;
  snapshot: ArticleSnapshot;
  onClose: () => void;
  onJumpToBlock: (order: number, id: string) => void;
  onRecoverExcluded: () => void;
  onJumpToEmptyBlock: (order: number, id: string) => void;
  onExport?: (snapshot: ArticleSnapshot, resultFile: ResultFile) => void;
  /** 导出进行中时的图片下载进度文案；预览是模态对话框，进度需在对话框内显示 */
  exportProgressText?: string | null;
}

/**
 * 依据 Issue #31 与设计简报：
 * 「检查结果」汇总预览对话框。
 * 纸张相同，但去掉全部批注、朱红标记、块序号和取舍控件，只剩成稿清样。
 * 模态展示，固定标题、切换与底部，仅正文区滚动。
 */
export const PreviewDialog: React.FC<PreviewDialogProps> = ({
  isOpen,
  snapshot,
  onClose,
  onJumpToBlock,
  onRecoverExcluded,
  onJumpToEmptyBlock,
  onExport,
  exportProgressText,
}) => {
  const readingTabRef = useRef<HTMLButtonElement | null>(null);
  const sourceTabRef = useRef<HTMLButtonElement | null>(null);

  const [activeTab, setActiveTab] = useState<'reading' | 'source'>('reading');
  const [hasVisitedSource, setHasVisitedSource] = useState(false);
  const [isDegradationExpanded, setIsDegradationExpanded] = useState(false);
  // 长文性能优化：超过 50 块时长文首开优先渲染首屏 40 块充盈视口，首帧绘制后无缝呈现全文
  const [renderAllChunks, setRenderAllChunks] = useState(false);

  React.useEffect(() => {
    if (isOpen) {
      if (!renderAllChunks) {
        const id = requestAnimationFrame(() => {
          setRenderAllChunks(true);
        });
        return () => cancelAnimationFrame(id);
      }
    } else {
      setRenderAllChunks(false);
    }
  }, [isOpen]);

  // 打开瞬间冻结快照：对话框打开期间即使迟到的保存改写了 snapshot，也不重新生成
  // 使用 ref 同步冻结，首帧渲染即产出缓存，避免 setState 引发二次渲染开销
  const frozenSnapshotRef = useRef<ArticleSnapshot | null>(null);
  if (isOpen && frozenSnapshotRef.current === null) {
    frozenSnapshotRef.current = snapshot;
  } else if (!isOpen && frozenSnapshotRef.current !== null) {
    frozenSnapshotRef.current = null;
  }
  const frozenSnapshot = frozenSnapshotRef.current;

  // 打开时从当前内存内容生成一次（对话框打开期间不刷新）
  const cachedData = useMemo(() => {
    if (!frozenSnapshot) return null;
    const snap = frozenSnapshot;

    // 单次循环同时完成：1. Markdown 拼装（免去二次遍历 600 块）2. 保留/空块统计 3. 降级条目提取
    const markdownParts: string[] = [];
    let includedCount = 0;
    let emptyCount = 0;
    let allExcluded = true;
    let firstEmptyBlock: Block | null = null;
    const degradationItems: DegradationItem[] = [];
    const typeCountMap: Record<string, number> = {};

    for (let i = 0; i < snap.blocks.length; i++) {
      const b = snap.blocks[i];
      if (!b.included) continue;
      allExcluded = false;
      const md = currentMarkdown(b);
      const trimmed = md ? md.trim() : '';
      if (trimmed === '') {
        emptyCount++;
        if (!firstEmptyBlock) {
          firstEmptyBlock = b;
        }
      } else {
        includedCount++;
        markdownParts.push(stripBoundaryEmptyLines(md));
        if (b.notes && b.notes.length > 0) {
          for (let j = 0; j < b.notes.length; j++) {
            const note = b.notes[j];
            const typeName =
              PREVIEW_COPY.degradationTypeLabels[note.code] ||
              PREVIEW_COPY.degradationTypeLabels.fallback;
            typeCountMap[note.code] = (typeCountMap[note.code] || 0) + 1;

            const firstLine = trimmed.split('\n')[0] || '';
            const summary = truncateGraphemes(firstLine || note.message, 40);

            degradationItems.push({
              blockOrder: b.order,
              blockId: b.id,
              code: note.code,
              typeName,
              summary,
            });
          }
        }
      }
    }

    const body = markdownParts.join('\n\n');
    const frontMatter = buildFrontMatter(snap.source);
    const text = frontMatter ? `${frontMatter}\n\n${body}\n` : (body ? `${body}\n` : '');
    const resultFile: ResultFile = { frontMatter, body, text };

    // 格式化降级汇总摘要
    const priorityCodes = ['table-degraded', 'richmedia-placeholder', 'convert-failed'];
    const summaryParts: string[] = [];
    for (const code of priorityCodes) {
      if (typeCountMap[code]) {
        const typeName = PREVIEW_COPY.degradationTypeLabels[code];
        summaryParts.push(PREVIEW_COPY.degradationItemCount(typeName, typeCountMap[code]));
      }
    }
    for (const [code, count] of Object.entries(typeCountMap)) {
      if (!priorityCodes.includes(code)) {
        const typeName =
          PREVIEW_COPY.degradationTypeLabels[code] || PREVIEW_COPY.degradationTypeLabels.fallback;
        summaryParts.push(PREVIEW_COPY.degradationItemCount(typeName, count));
      }
    }
    const hasBody = resultFile.body.trim() !== '';
    const isVeryLong = markdownParts.length > 50;
    const bodyForRender = isVeryLong && !renderAllChunks
      ? markdownParts.slice(0, 40).join('\n\n')
      : resultFile.body;
    // 整篇正文直接走净化后的 DOM 片段，省掉一次序列化与重新解析（600 块长文下是预览生成的主要开销之一）
    const renderedBodyNode = hasBody
      ? renderFragmentWithImages(renderMarkdownToFragment(bodyForRender))
      : null;

    const { source } = snap;
    return {
      header: {
        title: source.title?.trim() || '',
        account: source.account?.trim() || '',
        date: parseFrontMatterDate(source.publishedAt),
        url: source.url?.trim() || '',
      },
      resultFile,
      hasBody,
      renderedBodyNode,
      includedCount,
      emptyCount,
      allExcluded,
      firstEmptyBlock,
      degradationItems,
      degradationSummary: summaryParts.join(' · '),
    };
  }, [frozenSnapshot, renderAllChunks]);

  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // 控制视图状态重置与焦点（在浏览器排版绘制前同步激活 showModal 与聚焦）
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setActiveTab('reading');
      setHasVisitedSource(false);
      setIsDegradationExpanded(false);

      if (!dialog.open) {
        dialog.showModal();
      }
      readingTabRef.current?.focus();
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

  // 键盘切换 Tab（方向键支持）
  const handleTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveTab('source');
      setHasVisitedSource(true);
      sourceTabRef.current?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveTab('reading');
      readingTabRef.current?.focus();
    }
  };

  const handleSelectTab = (tab: 'reading' | 'source') => {
    setActiveTab(tab);
    if (tab === 'source') {
      setHasVisitedSource(true);
    }
  };

  if (!isOpen || !cachedData) {
    return null;
  }

  const {
    header,
    resultFile,
    hasBody,
    renderedBodyNode,
    includedCount,
    emptyCount,
    allExcluded,
    firstEmptyBlock,
    degradationItems,
    degradationSummary,
  } = cachedData;

  // 不在原生模态上隔离 layout：其内部 Portal 的 fixed 原图查看器需要以视口为包含块。
  return (
    <DialogPortalContainer value={dialogRef}>
    <dialog
      ref={dialogRef}
      className={cn(
        'preview-dialog fixed inset-0 m-auto z-50',
        'w-[min(840px,calc(100vw-32px))] h-[min(92vh,960px)] max-h-[calc(100vh-32px)]',
        'bg-sheet-bg text-ink-primary border border-sheet-border rounded-[3px]',
        'shadow-[0_16px_48px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)]',
        'overflow-hidden flex flex-col p-0 focus:outline-none',
        'backdrop:bg-ink-primary/50 backdrop:backdrop-blur-[1.5px]'
      )}
      data-testid="preview-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
          {/* 1. 标题行 + 统计 + 视图切换 + 降级汇总条（固定顶部） */}
          <div className="preview-dialog-header shrink-0 p-4 sm:px-6 sm:py-3.5 border-b border-sheet-border bg-surface-raised flex flex-col gap-2.5">
            <div className="preview-title-row flex justify-between items-center">
              <div className="preview-title-group flex items-center gap-2.5">
                <h2 className="preview-dialog-title text-[17px] font-semibold text-ink-primary leading-snug">
                  {PREVIEW_COPY.dialogTitle}
                </h2>
                <span className="preview-stamp border border-prussian-blue text-prussian-blue px-1.5 py-px text-[11px] rounded-xs font-semibold tracking-wider" aria-hidden="true">
                  {PREVIEW_COPY.stamp}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="preview-dialog-close-btn h-7 w-7 text-ink-secondary hover:text-ink-primary hover:bg-black/5 rounded-xs"
                aria-label={PREVIEW_COPY.closeButtonAria}
                onClick={onClose}
                data-testid="preview-btn-close"
              >
                <CloseIcon />
              </Button>
            </div>

            {/* 2. 统计 */}
            <div className="preview-stats-line text-xs text-ink-secondary" data-testid="preview-stats-line">
              {emptyCount > 0
                ? PREVIEW_COPY.statsWithEmpty(includedCount, emptyCount)
                : PREVIEW_COPY.statsWithoutEmpty(includedCount)}
            </div>

            {/* 3. 视图切换（tablist） */}
            <div
              className="preview-view-tabs flex gap-2"
              role="tablist"
              aria-label={PREVIEW_COPY.tabsAriaLabel}
              data-testid="preview-view-tabs"
            >
              <Button
                ref={readingTabRef}
                type="button"
                role="tab"
                id="preview-tab-reading"
                aria-controls="preview-panel-reading"
                aria-selected={activeTab === 'reading'}
                tabIndex={activeTab === 'reading' ? 0 : -1}
                variant="outline"
                size="sm"
                className={cn(
                  'preview-tab-btn h-7 px-3.5 text-xs font-medium rounded-xs transition-colors',
                  activeTab === 'reading'
                    ? 'is-active bg-ink-primary text-ink-inverse border-ink-primary hover:bg-ink-primary hover:text-ink-inverse'
                    : 'bg-sheet-bg text-ink-secondary hover:text-ink-primary hover:border-ink-secondary'
                )}
                data-testid="preview-tab-reading"
                onClick={() => handleSelectTab('reading')}
                onKeyDown={handleTabKeyDown}
              >
                {PREVIEW_COPY.tabReading}
              </Button>
              <Button
                ref={sourceTabRef}
                type="button"
                role="tab"
                id="preview-tab-source"
                aria-controls="preview-panel-source"
                aria-selected={activeTab === 'source'}
                tabIndex={activeTab === 'source' ? 0 : -1}
                variant="outline"
                size="sm"
                className={cn(
                  'preview-tab-btn h-7 px-3.5 text-xs font-medium rounded-xs transition-colors',
                  activeTab === 'source'
                    ? 'is-active bg-ink-primary text-ink-inverse border-ink-primary hover:bg-ink-primary hover:text-ink-inverse'
                    : 'bg-sheet-bg text-ink-secondary hover:text-ink-primary hover:border-ink-secondary'
                )}
                data-testid="preview-tab-source"
                onClick={() => handleSelectTab('source')}
                onKeyDown={handleTabKeyDown}
              >
                {PREVIEW_COPY.tabSource}
              </Button>
            </div>

            {/* 4. 降级汇总条（可折叠） */}
            {degradationItems.length > 0 && (
              <div className="preview-degradation-bar border border-amber bg-amber-subtle rounded-xs p-1.5 sm:px-3 text-xs flex flex-col gap-1.5" data-testid="preview-degradation-bar">
                <button
                  type="button"
                  className="degradation-summary-toggle appearance-none bg-transparent border-none flex items-center gap-1.5 cursor-pointer text-left w-full text-ink-primary font-medium p-0 focus-visible:outline-2 focus-visible:outline-amber focus-visible:outline-offset-2"
                  aria-expanded={isDegradationExpanded}
                  aria-label={
                    isDegradationExpanded
                      ? PREVIEW_COPY.toggleDegradationCollapse
                      : PREVIEW_COPY.toggleDegradationExpand
                  }
                  onClick={() => setIsDegradationExpanded((v) => !v)}
                  data-testid="degradation-summary-toggle"
                >
                  <span className="degradation-summary-icon text-[10px] text-ink-secondary w-3" aria-hidden="true">
                    {isDegradationExpanded ? '▼' : '▶'}
                  </span>
                  <span className="degradation-summary-text flex-1" data-testid="degradation-summary-text">
                    {degradationSummary}
                  </span>
                </button>

                {isDegradationExpanded && (
                  <ul className="degradation-items-list list-none mt-1 pt-1.5 border-t border-dashed border-amber/40 flex flex-col gap-1 max-h-40 overflow-y-auto" data-testid="degradation-items-list">
                    {degradationItems.map((item, index) => (
                      <li key={`${item.blockId}-${item.code}-${index}`} className="degradation-item-row w-full">
                        <button
                          type="button"
                          className="degradation-item-jump-btn appearance-none bg-transparent border border-transparent rounded-xs flex items-baseline gap-1.5 cursor-pointer text-left w-full px-1.5 py-1 text-ink-primary text-xs transition-colors hover:bg-amber/15 hover:border-amber/30 focus-visible:outline-2 focus-visible:outline-amber focus-visible:outline-offset-1"
                          aria-label={PREVIEW_COPY.jumpToDegradationBlockAria(item.blockOrder, item.typeName)}
                          onClick={() => onJumpToBlock(item.blockOrder, item.blockId)}
                          data-testid="degradation-item-jump-btn"
                        >
                          <span className="degradation-item-order font-mono font-semibold text-[11px] text-vermilion">#{item.blockOrder}</span>
                          <span className="degradation-item-type font-medium">{item.typeName}</span>
                          <span className="degradation-item-separator text-ink-tertiary">—</span>
                          <span className="degradation-item-summary text-ink-secondary overflow-hidden text-ellipsis whitespace-nowrap flex-1">{item.summary}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* 5. 可滚动的正文区 */}
          <div className="preview-dialog-body flex-1 min-h-0 [contain:layout] overflow-y-auto p-5 sm:p-7 md:px-9 bg-surface-raised" data-testid="preview-dialog-body">
            {!hasBody ? (
              /* 空正文状态 */
              <div className="preview-empty-state flex justify-center items-center min-h-[240px] py-6" data-testid="preview-empty-state">
                <div className="empty-state-card relative border border-sheet-border rounded-xs p-7 sm:px-8 bg-sheet-bg flex flex-col items-center text-center max-w-[440px] w-full">
                  <div className="empty-state-stamp absolute top-3 right-3 border border-ink-tertiary text-ink-tertiary text-[11px] px-1.5 py-px rounded-xs rotate-[4deg] tracking-wider" aria-hidden="true">{PREVIEW_COPY.emptyStamp}</div>
                  <h3 className="empty-state-title text-base font-semibold text-ink-primary mb-2">{PREVIEW_COPY.emptyTitle}</h3>
                  <p className="empty-state-desc text-[13px] text-ink-secondary mb-4 leading-normal">
                    {allExcluded
                      ? PREVIEW_COPY.emptyReasonAllExcluded
                      : PREVIEW_COPY.emptyReasonAllEmpty}
                  </p>
                  <div className="empty-state-actions flex gap-2.5">
                    {allExcluded ? (
                      <Button
                        type="button"
                        className="action-btn action-recover-excluded bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
                        data-testid="preview-btn-recover-excluded"
                        onClick={onRecoverExcluded}
                      >
                        {PREVIEW_COPY.btnRecoverExcluded}
                      </Button>
                    ) : firstEmptyBlock ? (
                      <Button
                        type="button"
                        className="action-btn action-jump-first-empty bg-prussian-blue hover:bg-prussian-blue-strong text-ink-inverse"
                        data-testid="preview-btn-jump-first-empty"
                        onClick={() => onJumpToEmptyBlock(firstEmptyBlock.order, firstEmptyBlock.id)}
                      >
                        {PREVIEW_COPY.btnJumpToFirstEmpty}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* 阅读预览视图 */}
                <div
                  id="preview-panel-reading"
                  role="tabpanel"
                  aria-labelledby="preview-tab-reading"
                  className={cn('preview-panel preview-panel-reading', activeTab === 'reading' ? 'block' : 'hidden')}
                  data-testid="preview-panel-reading"
                >
                  {/* 稿头：排版自 front-matter 四个字段 */}
                  <div className="preview-article-header mb-6 pb-4 border-b border-sheet-border" data-testid="preview-article-header">
                    {header.title && (
                      <h1 className="preview-article-title text-xl sm:text-[22px] font-bold text-ink-primary leading-snug mb-2.5">{header.title}</h1>
                    )}
                    <div className="preview-article-meta flex flex-wrap gap-3.5 text-xs text-ink-secondary">
                      {header.account && (
                        <span className="preview-meta-item preview-meta-account">
                          <strong className="text-ink-primary font-semibold">{PREVIEW_COPY.accountPrefix}</strong>
                          {header.account}
                        </span>
                      )}
                      {header.date && (
                        <span className="preview-meta-item preview-meta-date">
                          <strong className="text-ink-primary font-semibold">{PREVIEW_COPY.datePrefix}</strong>
                          {header.date}
                        </span>
                      )}
                      {header.url && (
                        <span className="preview-meta-item preview-meta-source">
                          <strong className="text-ink-primary font-semibold">{PREVIEW_COPY.sourcePrefix}</strong>
                          <a href={header.url} target="_blank" rel="noopener noreferrer" className="text-prussian-blue hover:underline break-all">
                            {header.url}
                          </a>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 正文 Markdown 渲染 */}
                  <div className="preview-article-content [contain:layout]" data-testid="preview-article-content">
                    {renderedBodyNode}
                  </div>
                </div>

                {/* Markdown 源码视图（仅在第一次切到该视图时才生成 DOM） */}
                {hasVisitedSource && (
                  <div
                    id="preview-panel-source"
                    role="tabpanel"
                    aria-labelledby="preview-tab-source"
                    className={cn('preview-panel preview-panel-source', activeTab === 'source' ? 'block' : 'hidden')}
                    data-testid="preview-panel-source"
                  >
                    <pre
                      tabIndex={0}
                      className="preview-source-pre m-0 p-4 sm:p-5 font-mono text-[12.5px] leading-relaxed text-ink-primary bg-sheet-bg border border-sheet-border rounded-xs whitespace-pre-wrap break-words overflow-y-auto max-h-full focus-visible:outline-2 focus-visible:outline-prussian-blue focus-visible:outline-offset-2"
                      data-testid="preview-source-pre"
                      aria-label={PREVIEW_COPY.sourceAriaLabel}
                    >
                      {resultFile.text}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 6. 底部：「返回清洗」+ 导出主操作预留位置（固定底部） */}
          <div className="preview-dialog-footer p-3 sm:px-6 border-t border-sheet-border bg-sheet-bg flex justify-between items-center shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="action-btn action-return-cleaning bg-surface-raised border-sheet-border text-ink-primary hover:bg-surface-muted hover:border-ink-secondary"
              onClick={onClose}
              data-testid="preview-btn-return"
            >
              {PREVIEW_COPY.btnReturnToCleaning}
            </Button>

            {/* 导出主操作预留位置 */}
            <div className="preview-export-slot flex items-center min-h-8" data-testid="preview-export-slot">
              {exportProgressText && (
                <span className="export-progress text-[13px] text-ink-secondary tabular-nums whitespace-nowrap" role="status" data-testid="preview-export-progress">
                  {exportProgressText}
                </span>
              )}
              {hasBody && onExport && frozenSnapshot && (
                <Button
                  type="button"
                  size="sm"
                  className="action-btn action-export action-export-preview bg-vermilion hover:bg-vermilion-strong text-ink-inverse"
                  data-testid="preview-btn-export"
                  onClick={() => onExport(frozenSnapshot, resultFile)}
                  aria-label={EXPORT_COPY.previewExportAriaLabel}
                  aria-busy={exportProgressText ? true : undefined}
                >
                  {EXPORT_COPY.previewExportButton}
                </Button>
              )}
            </div>
          </div>
    </dialog>
    </DialogPortalContainer>
  );
};
