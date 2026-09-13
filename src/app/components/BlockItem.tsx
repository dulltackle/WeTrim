import React, { forwardRef } from 'react';
import { currentMarkdown, type Block } from '../../shared/types';
import { renderMarkdown } from '../preview/render';

export interface BlockItemProps {
  block: Block;
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
 * 依据 Issue #24：
 * 结构性转变：从调试视图换成真实阅读态——用已有的 renderMarkdown 渲染 currentMarkdown(block)，
 * 标题出真实层级、段落/列表/引用/表格/代码走真实语义标签。
 * 状态徽章（序号/类型/保留-剔除/已修改/内容为空）作为周边文字标签环绕内容，不侵入内容本身。
 * 标题层级、块序号、初始类型、保留/剔除、已修改、内容为空全部有文字表达。
 */
export const BlockItem = forwardRef<HTMLDivElement, BlockItemProps>(({ block }, ref) => {
  const typeLabel = BLOCK_TYPE_LABELS[block.type] || block.type;
  const levelText =
    block.type === 'heading' && block.headingLevel ? ` H${block.headingLevel}` : '';

  const markdown = currentMarkdown(block);
  const isEdited = block.editedMarkdown !== null;
  const isEmpty = markdown.trim() === '';

  const renderedHtml = !isEmpty ? renderMarkdown(markdown) : '';

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`block-item ${block.included ? 'block-included' : 'block-excluded'} ${
        isEdited ? 'block-is-edited' : ''
      } ${isEmpty ? 'block-is-empty' : ''}`}
      data-testid="block-item"
      data-block-id={block.id}
      data-block-type={block.type}
      data-block-order={block.order}
      data-block-included={block.included ? 'true' : 'false'}
      data-block-edited={isEdited ? 'true' : 'false'}
      data-block-empty={isEmpty ? 'true' : 'false'}
    >
      {/* 周边文字状态徽章标签 */}
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
