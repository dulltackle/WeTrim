import React, { forwardRef, useEffect, useState } from 'react';
import { currentMarkdown, type Block } from '../../shared/types';
import { truncateGraphemes } from '../../shared/grapheme';
import { renderMarkdown } from '../preview/render';

export interface BlockItemProps {
  block: Block;
  onToggle: (id: string) => void;
}

export const BLOCK_TYPE_LABELS: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  image: '图片',
  code: '代码',
  list: '列表',
  quote: '引用',
  table: '表格',
  divider: '分割线',
  formula: '公式',
  richMedia: '富媒体',
  unknown: '未知内容',
};

/**
 * 依据 Issue #24 & Issue #25：
 * - 真实阅读态：renderMarkdown 渲染 currentMarkdown(block)
 * - 独立保留 / 剔除：独立原生 <button> 控件切换
 * - 原位折叠摘要：剔除后折叠为单行摘要（类型徽章 + 20字素预览 + 恢复保留与展开入口）
 * - 恢复保留使用当前内容（保持 editedMarkdown）
 * - 列表、引用、表格整体取舍提示：「整体取舍，编辑 Markdown 可删改内部内容与图片」
 */
export const BlockItem = forwardRef<HTMLDivElement, BlockItemProps>(({ block, onToggle }, ref) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // 当外部重新包含该块时，重置折叠展开状态
  useEffect(() => {
    if (block.included) {
      setIsExpanded(false);
    }
  }, [block.included]);

  const handleToggle = () => {
    onToggle(block.id);
  };

  const typeLabel = BLOCK_TYPE_LABELS[block.type] || block.type;
  const levelText =
    block.type === 'heading' && block.headingLevel ? ` H${block.headingLevel}` : '';

  const markdown = currentMarkdown(block);
  const isEdited = block.editedMarkdown !== null;
  const isEmpty = markdown.trim() === '';

  // 列表、引用、表格为整体块，展示操作提示
  const isComposite = block.type === 'list' || block.type === 'quote' || block.type === 'table';

  const previewText = truncateGraphemes(markdown, 20);
  const summaryPreview = isEmpty ? '（内容为空）' : previewText;

  const isCollapsed = !block.included && !isExpanded;

  // 整体块提示图标与悬浮/聚焦浮层
  const compositeTip = isComposite ? (
    <span
      className="composite-block-tip-trigger"
      data-testid="composite-block-tip"
      tabIndex={0}
      role="note"
      aria-label="整体取舍，编辑 Markdown 可删改内部内容与图片"
    >
      <svg
        className="tip-icon"
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
      <span className="tip-tooltip" role="tooltip">
        整体取舍，编辑 Markdown 可删改内部内容与图片
      </span>
    </span>
  ) : null;

  // 折叠摘要态（剔除且未展开）
  if (isCollapsed) {
    return (
      <div
        ref={ref}
        tabIndex={-1}
        className={`block-item block-excluded block-collapsed ${
          isEdited ? 'block-is-edited' : ''
        } ${isEmpty ? 'block-is-empty' : ''}`}
        data-testid="block-item"
        data-block-id={block.id}
        data-block-type={block.type}
        data-block-order={block.order}
        data-block-included="false"
        data-block-edited={isEdited ? 'true' : 'false'}
        data-block-empty={isEmpty ? 'true' : 'false'}
        data-block-collapsed="true"
      >
        <div className="block-item-meta block-collapsed-summary-bar">
          <span className="block-order-badge" data-testid="block-order-badge">
            #{block.order}
          </span>
          <span
            className={`block-type-badge block-type-${block.type}`}
            data-testid="block-type-badge"
          >
            {typeLabel}
            {levelText}
          </span>
          {compositeTip}
          {isEdited && (
            <span className="block-edited-badge" data-testid="block-edited-badge">
              已修改
            </span>
          )}
          {isEmpty && (
            <span className="block-empty-badge" data-testid="block-empty-badge">
              内容为空
            </span>
          )}
          <span
            className="block-status-tag status-excluded"
            data-testid="block-status-tag"
          >
            剔除
          </span>

          <span className="block-summary-preview" data-testid="block-summary-preview">
            {summaryPreview}
          </span>

          <div className="block-item-actions">
            <button
              type="button"
              className="block-toggle-btn block-action-restore"
              data-testid="block-action-restore"
              aria-label={`恢复保留第 ${block.order} 块`}
              onClick={handleToggle}
            >
              恢复保留
            </button>
            <button
              type="button"
              className="block-toggle-btn block-action-expand"
              data-testid="block-action-expand"
              aria-label={`展开第 ${block.order} 块`}
              onClick={() => setIsExpanded(true)}
            >
              展开
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 展开态（保留态，或剔除后点击展开）
  const renderedHtml = !isEmpty ? renderMarkdown(markdown) : '';

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`block-item ${block.included ? 'block-included' : 'block-excluded block-expanded'} ${
        isEdited ? 'block-is-edited' : ''
      } ${isEmpty ? 'block-is-empty' : ''}`}
      data-testid="block-item"
      data-block-id={block.id}
      data-block-type={block.type}
      data-block-order={block.order}
      data-block-included={block.included ? 'true' : 'false'}
      data-block-edited={isEdited ? 'true' : 'false'}
      data-block-empty={isEmpty ? 'true' : 'false'}
      data-block-collapsed="false"
    >
      {/* 周边文字状态徽章与操作条 */}
      <div className="block-item-meta">
        <span className="block-order-badge" data-testid="block-order-badge">
          #{block.order}
        </span>
        <span
          className={`block-type-badge block-type-${block.type}`}
          data-testid="block-type-badge"
        >
          {typeLabel}
          {levelText}
        </span>
        {compositeTip}
        {isEdited && (
          <span className="block-edited-badge" data-testid="block-edited-badge">
            已修改
          </span>
        )}
        {isEmpty && (
          <span className="block-empty-badge" data-testid="block-empty-badge">
            内容为空
          </span>
        )}
        <span
          className={`block-status-tag ${block.included ? 'status-included' : 'status-excluded'}`}
          data-testid="block-status-tag"
        >
          {block.included ? '保留' : '剔除'}
        </span>

        <div className="block-item-actions">
          {block.included ? (
            <button
              type="button"
              className="block-toggle-btn block-action-exclude"
              data-testid="block-action-exclude"
              aria-label={`剔除第 ${block.order} 块`}
              onClick={handleToggle}
            >
              剔除
            </button>
          ) : (
            <>
              <button
                type="button"
                className="block-toggle-btn block-action-restore"
                data-testid="block-action-restore"
                aria-label={`恢复保留第 ${block.order} 块`}
                onClick={handleToggle}
              >
                恢复保留
              </button>
              <button
                type="button"
                className="block-toggle-btn block-action-collapse"
                data-testid="block-action-collapse"
                aria-label={`收起第 ${block.order} 块`}
                onClick={() => setIsExpanded(false)}
              >
                收起
              </button>
            </>
          )}
        </div>
      </div>

      {block.notes.length > 0 && (
        <div className="block-notes" data-testid="block-notes">
          {block.notes.map((note, idx) => (
            <div key={`${note.code}-${idx}`} className={`block-note note-code-${note.code}`}>
              <span className="note-badge">提示</span>
              <span className="note-message">{note.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* 真实阅读态：renderMarkdown 渲染语义 HTML */}
      {isEmpty ? (
        <div className="block-empty-placeholder" data-testid="block-empty-placeholder">
          （内容为空）
        </div>
      ) : (
        <div
          className="block-rendered-content"
          data-testid="block-rendered-content"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </div>
  );
});

BlockItem.displayName = 'BlockItem';
