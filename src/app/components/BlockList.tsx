import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import type { Block } from '../../shared/types';
import { BlockItem, BLOCK_TYPE_LABELS } from './BlockItem';

/**
 * ADR-0005 & Issue #24：
 * 全部块的唯一渲染入口。
 * 搜索、定位与焦点管理必须经由由此组件暴露的接口，不得绕过它直接查询 DOM。
 *
 * 对外暴露命令式接口：
 * - scrollToBlock(id): 平滑滚动至指定块
 * - focusBlock(id): 滚动并聚焦至指定块
 * - queryVisible(): 返回当前处于视口内的全部块 id 列表
 */
export interface BlockListHandle {
  scrollToBlock: (id: string) => void;
  focusBlock: (id: string) => void;
  queryVisible: () => string[];
}

export interface BlockListProps {
  blocks: Block[];
}

export const BlockList = forwardRef<BlockListHandle, BlockListProps>(({ blocks }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerItemRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(id, el);
    } else {
      itemRefs.current.delete(id);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBlock: (id: string) => {
        const el = itemRefs.current.get(id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      },
      focusBlock: (id: string) => {
        const el = itemRefs.current.get(id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          el.focus();
        }
      },
      queryVisible: (): string[] => {
        const visibleIds: string[] = [];
        const vTop = 0;
        const vBottom = typeof window !== 'undefined' ? window.innerHeight : 800;

        for (const [id, el] of itemRefs.current.entries()) {
          const rect = el.getBoundingClientRect();
          // 元素底部在视口顶部之下，且元素顶部在视口底部之上（部分或全部可见）
          if (rect.bottom > vTop && rect.top < vBottom) {
            visibleIds.push(id);
          }
        }
        return visibleIds;
      },
    }),
    []
  );

  // 汇总统计各类型分布，延续既有汇总条设计
  const countsByType = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of blocks) {
      counts[b.type] = (counts[b.type] || 0) + 1;
    }
    return counts;
  }, [blocks]);

  return (
    <div className="block-list" data-testid="block-list" ref={containerRef}>
      {/* 块流汇总条：展示块数与类型分布 */}
      <div className="block-list-summary-bar" data-testid="block-list-summary-bar">
        <div className="summary-title">
          <span className="summary-heading">内容块流</span>
          <span className="summary-total" data-testid="summary-total-blocks">
            共 {blocks.length} 块
          </span>
        </div>
        <div className="summary-chips">
          {Object.entries(countsByType).map(([type, count]) => (
            <span key={type} className={`summary-chip chip-${type}`}>
              {BLOCK_TYPE_LABELS[type] || type} {count}
            </span>
          ))}
        </div>
      </div>

      {/* 正文块连续流：单栏连续展开，不做虚拟列表，不做分段延迟 */}
      <div className="block-items-stream" data-testid="block-items-stream">
        {blocks.map((b) => (
          <BlockItem
            key={b.id}
            block={b}
            ref={(el) => registerItemRef(b.id, el)}
          />
        ))}
      </div>
    </div>
  );
});

BlockList.displayName = 'BlockList';
