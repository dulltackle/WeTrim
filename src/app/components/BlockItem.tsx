import React from 'react';
import { currentMarkdown, type Block } from '../../shared/types';

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

export const BlockItem: React.FC<BlockItemProps> = ({ block }) => {
  const typeLabel = BLOCK_TYPE_LABELS[block.type] || block.type;
  const levelText =
    block.type === 'heading' && block.headingLevel ? ` H${block.headingLevel}` : '';

  // 原始 HTML 摘要（保留前 160 字符，单行紧凑展示）
  const snippet =
    block.originalHtml.length > 160
      ? `${block.originalHtml.slice(0, 160)}…`
      : block.originalHtml;

  const markdown = currentMarkdown(block);

  return (
    <div
      className="block-item"
      data-testid="block-item"
      data-block-id={block.id}
      data-block-type={block.type}
      data-block-order={block.order}
    >
      <div className="block-item-meta">
        <span className="block-order-badge">#{block.order}</span>
        <span className={`block-type-badge block-type-${block.type}`}>
          {typeLabel}
          {levelText}
        </span>
        <span className="block-status-tag">{block.included ? '保留' : '剔除'}</span>
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

      {/* 每块独立转换出的只读 Markdown 结果 */}
      <div className="block-markdown-content" data-testid="block-markdown-content">
        <pre className="block-markdown-text">{markdown}</pre>
      </div>

      <div className="block-html-summary" title={block.originalHtml}>
        <code>{snippet}</code>
      </div>
    </div>
  );
};
