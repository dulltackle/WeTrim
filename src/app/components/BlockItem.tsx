import React from 'react';
import type { Block } from '../../shared/types';

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
      <div className="block-html-summary" title={block.originalHtml}>
        <code>{snippet}</code>
      </div>
    </div>
  );
};
