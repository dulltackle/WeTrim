import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Block } from '../../shared/types';
import { BlockItem } from './BlockItem';
import { useAppContext } from '../state/session-context';

export type BlockFilterMode = 'all' | 'included' | 'excluded';

export const EMPTY_FILTER_MESSAGES: Record<BlockFilterMode, string> = {
  excluded: '没有被剔除的块',
  included: '没有保留的块',
  all: '暂无内容块',
};

/**
 * ADR-0005, Issue #24 & Issue #25：
 * 全部块的唯一渲染入口。
 * 搜索、定位与焦点管理必须经由由此组件暴露的接口，不得绕过它直接查询 DOM。
 *
 * 对外暴露命令式接口：
 * - scrollToBlock(id): 平滑滚动至指定块
 * - focusBlock(id): 滚动并聚焦至指定块
 * - queryVisible(): 返回当前处于视口内的全部块 id 列表
 * - setFilter(filter): 切换三态筛选（'all' | 'included' | 'excluded'）
 * - getFilter(): 获取当前筛选状态
 */
export interface BlockListHandle {
  scrollToBlock: (id: string) => void;
  focusBlock: (id: string) => void;
  queryVisible: () => string[];
  setFilter: (filter: BlockFilterMode) => void;
  getFilter: () => BlockFilterMode;
}

export interface BlockListProps {
  blocks: Block[];
}

export const BlockList = forwardRef<BlockListHandle, BlockListProps>(({ blocks }, ref) => {
  const { dispatch } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [filter, setFilter] = useState<BlockFilterMode>('all');

  const registerItemRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(id, el);
    } else {
      itemRefs.current.delete(id);
    }
  }, []);

  // 统计数据
  const totalCount = blocks.length;
  const includedCount = useMemo(() => blocks.filter((b) => b.included).length, [blocks]);
  const excludedCount = totalCount - includedCount;

  // 当前筛选下的可见块列表
  const visibleBlocks = useMemo(() => {
    if (filter === 'included') {
      return blocks.filter((b) => b.included);
    }
    if (filter === 'excluded') {
      return blocks.filter((b) => !b.included);
    }
    return blocks;
  }, [blocks, filter]);

  // 切换筛选处理（保持滚动位置与合理焦点）
  const handleFilterChange = useCallback((nextFilter: BlockFilterMode) => {
    if (nextFilter === filter) return;

    // 检查当前活动焦点是否在某一个块内
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    let activeBlockId: string | null = null;
    if (activeEl) {
      for (const [id, el] of itemRefs.current.entries()) {
        if (el === activeEl || el.contains(activeEl)) {
          activeBlockId = id;
          break;
        }
      }
    }

    // 计算在新筛选下可见的块
    let nextVisible: Block[] = blocks;
    if (nextFilter === 'included') {
      nextVisible = blocks.filter((b) => b.included);
    } else if (nextFilter === 'excluded') {
      nextVisible = blocks.filter((b) => !b.included);
    }

    setFilter(nextFilter);

    // 若聚焦块在新筛选下仍可见，则不动焦点与滚动
    // 若聚焦块在新筛选下不可见，则将焦点平稳转移至下一个可见块，避免焦点重置跳顶
    if (activeBlockId && !nextVisible.some((b) => b.id === activeBlockId)) {
      const oldIndex = blocks.findIndex((b) => b.id === activeBlockId);
      const nextTarget =
        nextVisible.find((b) => b.order > (blocks[oldIndex]?.order ?? 0)) ||
        nextVisible[nextVisible.length - 1];

      if (nextTarget) {
        setTimeout(() => {
          const el = itemRefs.current.get(nextTarget.id);
          if (el) {
            el.focus({ preventScroll: true });
          }
        }, 0);
      }
    }
  }, [blocks, filter]);

  // 块取舍切换处理（在筛选视图下剔除/恢复导致块从视图消失时，焦点平稳前移）
  const handleToggleBlock = useCallback((blockId: string) => {
    if (filter === 'all') {
      // 全部视图下，原位折叠/展开，不移出视图
      dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId } });
      return;
    }

    // 在「保留」/「剔除」视图下切换当前块会使其从视图消失：焦点前移到列表中下一个可见块
    const currentIndex = visibleBlocks.findIndex((b) => b.id === blockId);
    let nextFocusId: string | null = null;
    if (currentIndex !== -1) {
      if (currentIndex + 1 < visibleBlocks.length) {
        nextFocusId = visibleBlocks[currentIndex + 1].id;
      } else if (currentIndex > 0) {
        nextFocusId = visibleBlocks[currentIndex - 1].id;
      }
    }

    dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId } });

    if (nextFocusId) {
      setTimeout(() => {
        const el = itemRefs.current.get(nextFocusId!);
        if (el) {
          el.focus();
        }
      }, 0);
    }
  }, [dispatch, filter, visibleBlocks]);

  const handleUpdateBlock = useCallback(
    (blockId: string, editedMarkdown: string | null) => {
      dispatch({ type: 'UPDATE_BLOCK', payload: { blockId, editedMarkdown } });
    },
    [dispatch]
  );

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
          if (rect.bottom > vTop && rect.top < vBottom) {
            visibleIds.push(id);
          }
        }
        return visibleIds;
      },
      setFilter: (f: BlockFilterMode) => handleFilterChange(f),
      getFilter: () => filter,
    }),
    [filter, handleFilterChange]
  );

  return (
    <div className="block-list" data-testid="block-list" ref={containerRef}>
      {/* 块流汇总条：展示总块数与三态筛选 Tabs（原 summary-chips 位置） */}
      <div className="block-list-summary-bar" data-testid="block-list-summary-bar">
        <div className="summary-title">
          <span className="summary-heading">内容块流</span>
          <span className="summary-total" data-testid="summary-total-blocks">
            共 {totalCount} 块
          </span>
        </div>
        <div
          className="summary-chips filter-tabs"
          role="tablist"
          aria-label="内容块筛选"
          data-testid="filter-tabs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`summary-chip filter-tab ${filter === 'all' ? 'is-active' : ''}`}
            data-testid="filter-tab-all"
            data-filter="all"
            onClick={() => handleFilterChange('all')}
          >
            全部 {totalCount}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'included'}
            className={`summary-chip filter-tab ${filter === 'included' ? 'is-active' : ''}`}
            data-testid="filter-tab-included"
            data-filter="included"
            onClick={() => handleFilterChange('included')}
          >
            保留 {includedCount}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'excluded'}
            className={`summary-chip filter-tab ${filter === 'excluded' ? 'is-active' : ''}`}
            data-testid="filter-tab-excluded"
            data-filter="excluded"
            onClick={() => handleFilterChange('excluded')}
          >
            剔除 {excludedCount}
          </button>
        </div>
      </div>

      {/* 筛选为空时的非模态说明 */}
      {visibleBlocks.length === 0 && (
        <div className="block-list-empty-filter" data-testid="block-list-empty-filter">
          {EMPTY_FILTER_MESSAGES[filter]}
        </div>
      )}

      {/* 正文块连续流：单栏连续展开，不做虚拟列表，不做分段延迟 */}
      {visibleBlocks.length > 0 && (
        <div className="block-items-stream" data-testid="block-items-stream">
          {visibleBlocks.map((b) => (
            <BlockItem
              key={b.id}
              block={b}
              onToggle={handleToggleBlock}
              onUpdate={handleUpdateBlock}
              ref={(el) => registerItemRef(b.id, el)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

BlockList.displayName = 'BlockList';
