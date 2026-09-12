import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
import type { Block } from '../../shared/types';
import { BlockItem, BLOCK_TYPE_LABELS } from './BlockItem';

/**
 * ADR-0005: 全部块的唯一渲染入口。
 * 搜索、定位与焦点管理必须经由由此组件暴露的接口，不得绕过它直接查询 DOM。
 */
export interface BlockListHandle {
  scrollToBlock: (id: string) => void;
  focusBlock: (id: string) => void;
}

export interface BlockListProps {
  blocks: Block[];
}

export const BlockList = forwardRef<BlockListHandle, BlockListProps>(({ blocks }, ref) => {
  useImperativeHandle(ref, () => ({
    scrollToBlock: (_id: string) => {},
    focusBlock: (_id: string) => {},
  }));

  // 汇总统计各类型分布，方便在验收样例上核对
  const countsByType = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of blocks) {
      counts[b.type] = (counts[b.type] || 0) + 1;
    }
    return counts;
  }, [blocks]);

  return (
    <div className="block-list" data-testid="block-list">
      <div className="block-list-summary-bar">
        <div className="summary-title">
          <span className="summary-heading">内容块流</span>
          <span className="summary-total">共 {blocks.length} 块</span>
        </div>
        <div className="summary-chips">
          {Object.entries(countsByType).map(([type, count]) => (
            <span key={type} className={`summary-chip chip-${type}`}>
              {BLOCK_TYPE_LABELS[type] || type} {count}
            </span>
          ))}
        </div>
      </div>
      <div className="block-items-stream">
        {blocks.map((b) => (
          <BlockItem key={b.id} block={b} />
        ))}
      </div>
    </div>
  );
});

BlockList.displayName = 'BlockList';
