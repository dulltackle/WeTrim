import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArticleSnapshot, Block } from '../../shared/types';
import { currentMarkdown } from '../../shared/types';
import { buildResultFile, parseFrontMatterDate, type ResultFile } from '../export/build-markdown';
import { renderMarkdownToFragment } from '../preview/render';
import { renderFragmentWithImages } from '../preview/html-to-react';
import { truncateGraphemes } from '../../shared/grapheme';
import { PREVIEW_COPY } from '../copy/preview';
import { EXPORT_COPY } from '../copy/export';
import { CloseIcon } from './CloseIcon';

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
}

/**
 * 依据 Issue #31 与设计简报：
 * 「检查结果」汇总预览对话框。
 * 纸张相同，但去掉全部批注、朱红标记、块序号和取舍控件，只剩成稿清样。
 * 原生 <dialog> showModal() 模态展示，固定标题、切换与底部，仅正文区滚动。
 */
export const PreviewDialog: React.FC<PreviewDialogProps> = ({
  isOpen,
  snapshot,
  onClose,
  onJumpToBlock,
  onRecoverExcluded,
  onJumpToEmptyBlock,
  onExport,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const readingTabRef = useRef<HTMLButtonElement | null>(null);
  const sourceTabRef = useRef<HTMLButtonElement | null>(null);

  const [activeTab, setActiveTab] = useState<'reading' | 'source'>('reading');
  const [hasVisitedSource, setHasVisitedSource] = useState(false);
  const [isDegradationExpanded, setIsDegradationExpanded] = useState(false);

  // 打开瞬间冻结快照：对话框打开期间即使迟到的保存改写了 snapshot，也不重新生成
  const [frozenSnapshot, setFrozenSnapshot] = useState<ArticleSnapshot | null>(null);
  if (isOpen && frozenSnapshot === null) {
    setFrozenSnapshot(snapshot);
  } else if (!isOpen && frozenSnapshot !== null) {
    setFrozenSnapshot(null);
  }

  // 打开时从当前内存内容生成一次（对话框打开期间不刷新）
  const cachedData = useMemo(() => {
    if (!frozenSnapshot) return null;
    const snapshot = frozenSnapshot;

    const resultFile = buildResultFile(snapshot);

    // 单次循环统计保留/空块与降级条目，避免在 600 块长文下多次分配临时数组与重复 trim
    let includedCount = 0;
    let emptyCount = 0;
    let allExcluded = true;
    let firstEmptyBlock: Block | null = null;
    const degradationItems: DegradationItem[] = [];
    const typeCountMap: Record<string, number> = {};

    for (let i = 0; i < snapshot.blocks.length; i++) {
      const b = snapshot.blocks[i];
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
    // 整篇正文直接走净化后的 DOM 片段，省掉一次序列化与重新解析（600 块长文下是预览生成的主要开销之一）
    const renderedBodyNode = hasBody
      ? renderFragmentWithImages(renderMarkdownToFragment(resultFile.body))
      : null;

    const { source } = snapshot;
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
  }, [frozenSnapshot]);

  // 控制原生 <dialog> 打开与焦点（在浏览器排版绘制前同步激活 showModal 与聚焦）
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

  return (
    <dialog
      ref={dialogRef}
      className="preview-dialog"
      data-testid="preview-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {/* 1. 标题行 + 统计 + 视图切换 + 降级汇总条（固定顶部） */}
      <div className="preview-dialog-header">
        <div className="preview-title-row">
          <div className="preview-title-group">
            <h2 className="preview-dialog-title">{PREVIEW_COPY.dialogTitle}</h2>
            <span className="preview-stamp" aria-hidden="true">{PREVIEW_COPY.stamp}</span>
          </div>
          <button
            type="button"
            className="preview-dialog-close-btn"
            aria-label={PREVIEW_COPY.closeButtonAria}
            onClick={onClose}
            data-testid="preview-btn-close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* 2. 统计 */}
        <div className="preview-stats-line" data-testid="preview-stats-line">
          {emptyCount > 0
            ? PREVIEW_COPY.statsWithEmpty(includedCount, emptyCount)
            : PREVIEW_COPY.statsWithoutEmpty(includedCount)}
        </div>

        {/* 3. 视图切换（tablist） */}
        <div
          className="preview-view-tabs"
          role="tablist"
          aria-label={PREVIEW_COPY.tabsAriaLabel}
          data-testid="preview-view-tabs"
        >
          <button
            ref={readingTabRef}
            type="button"
            role="tab"
            id="preview-tab-reading"
            aria-controls="preview-panel-reading"
            aria-selected={activeTab === 'reading'}
            tabIndex={activeTab === 'reading' ? 0 : -1}
            className={`preview-tab-btn ${activeTab === 'reading' ? 'is-active' : ''}`}
            data-testid="preview-tab-reading"
            onClick={() => handleSelectTab('reading')}
            onKeyDown={handleTabKeyDown}
          >
            {PREVIEW_COPY.tabReading}
          </button>
          <button
            ref={sourceTabRef}
            type="button"
            role="tab"
            id="preview-tab-source"
            aria-controls="preview-panel-source"
            aria-selected={activeTab === 'source'}
            tabIndex={activeTab === 'source' ? 0 : -1}
            className={`preview-tab-btn ${activeTab === 'source' ? 'is-active' : ''}`}
            data-testid="preview-tab-source"
            onClick={() => handleSelectTab('source')}
            onKeyDown={handleTabKeyDown}
          >
            {PREVIEW_COPY.tabSource}
          </button>
        </div>

        {/* 4. 降级汇总条（可折叠） */}
        {degradationItems.length > 0 && (
          <div className="preview-degradation-bar" data-testid="preview-degradation-bar">
            <button
              type="button"
              className="degradation-summary-toggle"
              aria-expanded={isDegradationExpanded}
              aria-label={
                isDegradationExpanded
                  ? PREVIEW_COPY.toggleDegradationCollapse
                  : PREVIEW_COPY.toggleDegradationExpand
              }
              onClick={() => setIsDegradationExpanded((v) => !v)}
              data-testid="degradation-summary-toggle"
            >
              <span className="degradation-summary-icon" aria-hidden="true">
                {isDegradationExpanded ? '▼' : '▶'}
              </span>
              <span className="degradation-summary-text" data-testid="degradation-summary-text">
                {degradationSummary}
              </span>
            </button>

            {isDegradationExpanded && (
              <ul className="degradation-items-list" data-testid="degradation-items-list">
                {degradationItems.map((item, index) => (
                  <li key={`${item.blockId}-${item.code}-${index}`} className="degradation-item-row">
                    <button
                      type="button"
                      className="degradation-item-jump-btn"
                      aria-label={PREVIEW_COPY.jumpToDegradationBlockAria(item.blockOrder, item.typeName)}
                      onClick={() => onJumpToBlock(item.blockOrder, item.blockId)}
                      data-testid="degradation-item-jump-btn"
                    >
                      <span className="degradation-item-order">#{item.blockOrder}</span>
                      <span className="degradation-item-type">{item.typeName}</span>
                      <span className="degradation-item-separator">—</span>
                      <span className="degradation-item-summary">{item.summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* 5. 可滚动的正文区 */}
      <div className="preview-dialog-body" data-testid="preview-dialog-body">
        {!hasBody ? (
          /* 空正文状态 */
          <div className="preview-empty-state" data-testid="preview-empty-state">
            <div className="empty-state-card">
              <div className="empty-state-stamp" aria-hidden="true">{PREVIEW_COPY.emptyStamp}</div>
              <h3 className="empty-state-title">{PREVIEW_COPY.emptyTitle}</h3>
              <p className="empty-state-desc">
                {allExcluded
                  ? PREVIEW_COPY.emptyReasonAllExcluded
                  : PREVIEW_COPY.emptyReasonAllEmpty}
              </p>
              <div className="empty-state-actions">
                {allExcluded ? (
                  <button
                    type="button"
                    className="action-btn action-recover-excluded"
                    data-testid="preview-btn-recover-excluded"
                    onClick={onRecoverExcluded}
                  >
                    {PREVIEW_COPY.btnRecoverExcluded}
                  </button>
                ) : firstEmptyBlock ? (
                  <button
                    type="button"
                    className="action-btn action-jump-first-empty"
                    data-testid="preview-btn-jump-first-empty"
                    onClick={() => onJumpToEmptyBlock(firstEmptyBlock.order, firstEmptyBlock.id)}
                  >
                    {PREVIEW_COPY.btnJumpToFirstEmpty}
                  </button>
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
              className="preview-panel preview-panel-reading"
              data-testid="preview-panel-reading"
              style={{ display: activeTab === 'reading' ? 'block' : 'none' }}
            >
              {/* 稿头：排版自 front-matter 四个字段 */}
              <div className="preview-article-header" data-testid="preview-article-header">
                {header.title && (
                  <h1 className="preview-article-title">{header.title}</h1>
                )}
                <div className="preview-article-meta">
                  {header.account && (
                    <span className="preview-meta-item preview-meta-account">
                      <strong>{PREVIEW_COPY.accountPrefix}</strong>
                      {header.account}
                    </span>
                  )}
                  {header.date && (
                    <span className="preview-meta-item preview-meta-date">
                      <strong>{PREVIEW_COPY.datePrefix}</strong>
                      {header.date}
                    </span>
                  )}
                  {header.url && (
                    <span className="preview-meta-item preview-meta-source">
                      <strong>{PREVIEW_COPY.sourcePrefix}</strong>
                      <a href={header.url} target="_blank" rel="noopener noreferrer">
                        {header.url}
                      </a>
                    </span>
                  )}
                </div>
              </div>

              {/* 正文 Markdown 渲染 */}
              <div className="preview-article-content" data-testid="preview-article-content">
                {renderedBodyNode}
              </div>
            </div>

            {/* Markdown 源码视图（仅在第一次切到该视图时才生成 DOM） */}
            {hasVisitedSource && (
              <div
                id="preview-panel-source"
                role="tabpanel"
                aria-labelledby="preview-tab-source"
                className="preview-panel preview-panel-source"
                data-testid="preview-panel-source"
                style={{ display: activeTab === 'source' ? 'block' : 'none' }}
              >
                <pre
                  tabIndex={0}
                  className="preview-source-pre"
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
      <div className="preview-dialog-footer">
        <button
          type="button"
          className="action-btn action-return-cleaning"
          onClick={onClose}
          data-testid="preview-btn-return"
        >
          {PREVIEW_COPY.btnReturnToCleaning}
        </button>

        {/* 导出主操作预留位置（#31 不渲染假按钮，#32 接上） */}
        <div className="preview-export-slot" data-testid="preview-export-slot">
          {hasBody && onExport && frozenSnapshot && (
            <button
              type="button"
              className="action-btn action-export action-export-preview"
              data-testid="preview-btn-export"
              onClick={() => onExport(frozenSnapshot, resultFile)}
              aria-label={EXPORT_COPY.previewExportAriaLabel}
            >
              {EXPORT_COPY.previewExportButton}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
};
