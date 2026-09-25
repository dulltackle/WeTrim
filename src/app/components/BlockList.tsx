import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Block } from '../../shared/types';
import { BlockItem } from './BlockItem';
import { useAppContext } from '../state/session-context';
import {
  BlockPlainTextCache,
  findMatchesInText,
  createRangeForOffsets,
  locateVisibleMatchInMarkdown,
  EMPTY_SEARCH_STATE,
  type BlockHit,
  type SearchState,
} from '../search/text-search';

export type BlockFilterMode = 'all' | 'included' | 'excluded';

export const EMPTY_FILTER_MESSAGES: Record<BlockFilterMode, string> = {
  excluded: '没有被剔除的块',
  included: '没有保留的块',
  all: '暂无内容块',
};

export interface OrderLocateResult {
  status: 'success' | 'out_of_range' | 'hidden_by_filter';
  totalBlocks: number;
  targetOrder?: number;
  targetBlockId?: string;
  hiddenInFilter?: 'excluded' | 'included';
}

/**
 * ADR-0005, Issue #24, #25, #27 & #29：
 * 全部块的唯一渲染入口。
 * 搜索、定位、焦点管理与高亮 Range 处理必须经由此组件暴露的接口，不得绕过它直接查询 DOM。
 *
 * 对外暴露命令式接口：
 * - scrollToBlock(id): 平滑滚动至指定块
 * - focusBlock(id): 滚动并聚焦至指定块
 * - queryVisible(): 返回当前处于视口内的全部块 id 列表
 * - setFilter(filter, options): 切换三态筛选（'all' | 'included' | 'excluded'），可指定切换渲染完成后定位的序号
 * - getFilter(): 获取当前筛选状态
 * - getFocusedBlockId(): 获取当前处于焦点状态的块 id
 * - restoreFocus(id): 恢复指定块焦点
 * - search(query): 全文搜索
 * - clearSearch(): 清除搜索
 * - gotoHit(index): 跳转到指定命中
 * - gotoNextHit(): 下一处命中
 * - gotoPrevHit(): 上一处命中
 * - locateOrder(n): 序号定位
 * - focusCurrentHitBlock(): 将焦点还给当前命中块
 * - getSearchState(): 获取当前搜索状态
 * - getCounts(): 获取各状态计数
 */
export interface BlockListHandle {
  scrollToBlock: (id: string) => void;
  focusBlock: (id: string) => void;
  queryVisible: () => string[];
  setFilter: (filter: BlockFilterMode, options?: { thenLocateOrder?: number }) => void;
  getFilter: () => BlockFilterMode;
  getFocusedBlockId: () => string | null;
  restoreFocus: (id: string | null) => void;

  search: (query: string) => SearchState;
  clearSearch: () => void;
  gotoHit: (index: number) => { wrapped: boolean };
  gotoNextHit: () => { wrapped: boolean };
  gotoPrevHit: () => { wrapped: boolean };
  locateOrder: (n: number) => OrderLocateResult;
  focusCurrentHitBlock: () => void;
  getSearchState: () => SearchState;
  getCounts: () => { total: number; included: number; excluded: number };
}

export interface BlockListProps {
  blocks: Block[];
  filter?: BlockFilterMode;
  onFilterChange?: (filter: BlockFilterMode) => void;
  onSearchStateChange?: (state: SearchState) => void;
  /** 块从当前筛选视图中全部消失、没有可聚焦的块时，交由外部把焦点放回当前筛选页签 */
  onFocusFallback?: (filter: BlockFilterMode) => void;
}

export const BlockList = forwardRef<BlockListHandle, BlockListProps>(
  (
    {
      blocks,
      filter: controlledFilter,
      onFilterChange,
      onSearchStateChange,
      onFocusFallback,
    },
    ref
  ) => {
    const { dispatch } = useAppContext();
    const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    const isControlledFilter = controlledFilter !== undefined;
    const [internalFilter, setInternalFilter] = useState<BlockFilterMode>('all');
    const filter = isControlledFilter ? controlledFilter : internalFilter;

    // 搜索状态引用与缓存
    const plainTextCacheRef = useRef<BlockPlainTextCache>(new BlockPlainTextCache());
    const searchQueryRef = useRef<string>('');
    const allHitsRef = useRef<BlockHit[]>([]);
    const visibleHitsRef = useRef<BlockHit[]>([]);
    const currentHitIndexRef = useRef<number>(-1);
    const [tempExpandedBlockId, setTempExpandedBlockId] = useState<string | null>(null);
    const tempExpandedBlockIdRef = useRef<string | null>(null);
    tempExpandedBlockIdRef.current = tempExpandedBlockId;

    // 组件卸载时清理全局 CSS.highlights，防止 Range 强引用卸载 DOM 节点导致内存泄漏
    useEffect(() => {
      return () => {
        if (typeof CSS !== 'undefined' && CSS.highlights) {
          CSS.highlights.delete('search-hit');
          CSS.highlights.delete('search-hit-current');
        }
      };
    }, []);
    const lastTrimmedQueryRef = useRef<string>('');
    const prevBlocksRef = useRef(blocks);
    const searchStateRef = useRef<SearchState>(EMPTY_SEARCH_STATE);
    // 切换筛选后待定位的序号：须等新筛选下的块挂载完成才能滚动与聚焦
    const pendingLocateOrderRef = useRef<number | null>(null);
    const onFocusFallbackRef = useRef(onFocusFallback);
    onFocusFallbackRef.current = onFocusFallback;

    const refCallbacksRef = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
    const getRefCallback = useCallback((id: string) => {
      let cb = refCallbacksRef.current.get(id);
      if (!cb) {
        cb = (el: HTMLDivElement | null) => {
          if (el) {
            itemRefs.current.set(id, el);
          } else {
            itemRefs.current.delete(id);
          }
        };
        refCallbacksRef.current.set(id, cb);
      }
      return cb;
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

    const blocksRef = useRef(blocks);
    blocksRef.current = blocks;
    const filterRef = useRef(filter);
    filterRef.current = filter;
    const visibleBlocksRef = useRef(visibleBlocks);
    visibleBlocksRef.current = visibleBlocks;

    // 更新 CSS Custom Highlights 与页边刻痕属性
    const updateHighlightsAndNotches = useCallback(
      (query: string, visibleHits: BlockHit[], currentHitIdx: number) => {
        if (typeof window === 'undefined') return;

        const currentHit = currentHitIdx >= 0 ? visibleHits[currentHitIdx] : null;

        // 1. 设置所有可见/已挂载块的页边刻痕属性（仅当属性状态改变时更新 DOM，避免触发全量重排）
        const blocksWithHits = new Set(visibleHits.map((h) => h.blockId));
        for (const [id, el] of itemRefs.current.entries()) {
          const hasHit = blocksWithHits.has(id);
          const isCurrent = currentHit ? currentHit.blockId === id : false;
          if (hasHit) {
            if (el.getAttribute('data-has-hit') !== 'true') {
              el.setAttribute('data-has-hit', 'true');
            }
          } else {
            if (el.hasAttribute('data-has-hit')) {
              el.removeAttribute('data-has-hit');
            }
          }
          if (isCurrent) {
            if (el.getAttribute('data-is-current-hit') !== 'true') {
              el.setAttribute('data-is-current-hit', 'true');
            }
          } else {
            if (el.hasAttribute('data-is-current-hit')) {
              el.removeAttribute('data-is-current-hit');
            }
          }
        }

        // 2. 清理现有 CSS Custom Highlights
        if (typeof CSS !== 'undefined' && CSS.highlights) {
          CSS.highlights.delete('search-hit');
          CSS.highlights.delete('search-hit-current');

          if (!query || visibleHits.length === 0) {
            return;
          }

          const otherRanges: Range[] = [];
          const currentRanges: Range[] = [];

          // 分组计算每个块的 Range
          visibleHits.forEach((hit, hitIdx) => {
            const el = itemRefs.current.get(hit.blockId);
            if (!el) return;

            // 如果该块在编辑中，选区交给 textarea 处理
            const textarea = el.querySelector('textarea');
            if (textarea) return;

            // 查找渲染内容容器（如果临时展开，容器也是 block-rendered-content）
            const contentEl = el.querySelector('.block-rendered-content');
            if (!contentEl) return;

            const range = createRangeForOffsets(contentEl, hit.startOffset, hit.endOffset);
            if (range) {
              if (hitIdx === currentHitIdx) {
                currentRanges.push(range);
              } else {
                otherRanges.push(range);
              }
            }
          });

          if (otherRanges.length > 0) {
            CSS.highlights.set('search-hit', new Highlight(...otherRanges));
          }
          if (currentRanges.length > 0) {
            CSS.highlights.set('search-hit-current', new Highlight(...currentRanges));
          }
        }
      },
      []
    );

    // 激活指定命中处（滚动定位、临时展开与编辑框选区定位）
    const activateHit = useCallback(
      (hit: BlockHit, query: string) => {
        const block = blocks.find((b) => b.id === hit.blockId);
        if (!block) return;

        const applyTargetAction = (el: HTMLElement) => {
          // 块条目滚动到视口，scroll-margin-top 保证不被固定顶栏遮挡
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

          // 命中在编辑中的块：把编辑框选区定位到这处匹配。
          // 只设选区不抢焦点：焦点仍留在搜索框，否则后续输入与 Enter 会写进正文；Esc 交还焦点时选区随之显现。
          // 以 textarea 当前值（含未保存的本地修改）换算，避免与防抖提交前的旧内容错位。
          const textarea = el.querySelector('textarea') as HTMLTextAreaElement | null;
          if (textarea) {
            const sel = locateVisibleMatchInMarkdown(textarea.value, query, hit.matchIndex);
            if (sel) {
              textarea.setSelectionRange(sel.start, sel.end);
            }
          }
        };

        // 如果是折叠的剔除块，设置临时展开
        let needTempExpand = false;
        if (!block.included) {
          const el = itemRefs.current.get(hit.blockId);
          // 若处于折叠状态，或当前正处于临时展开状态，保持临时展开
          if (
            (el && el.getAttribute('data-block-collapsed') === 'true') ||
            tempExpandedBlockIdRef.current === hit.blockId
          ) {
            needTempExpand = true;
          }
        }

        if (needTempExpand) {
          if (tempExpandedBlockIdRef.current !== hit.blockId) {
            setTempExpandedBlockId(hit.blockId);
          }
          // 等待展开与布局完成后滚动并高亮
          if (typeof window !== 'undefined' && window.requestAnimationFrame) {
            window.requestAnimationFrame(() => {
              const el = itemRefs.current.get(hit.blockId);
              if (el) applyTargetAction(el);
            });
          } else {
            const el = itemRefs.current.get(hit.blockId);
            if (el) applyTargetAction(el);
          }
        } else {
          setTempExpandedBlockId(null);
          const el = itemRefs.current.get(hit.blockId);
          if (el) applyTargetAction(el);
        }
      },
      [blocks]
    );

    // 计算搜索状态并更新
    const executeSearch = useCallback(
      (
        query: string,
        currentFilter: BlockFilterMode,
        targetHitIndex?: number,
        // highlight: false 用于重新渲染前调用的场景（筛选切换、blocks 变更），高亮交由提交后的 effect 按新 DOM 重建
        options?: { scroll?: boolean; highlight?: boolean }
      ): SearchState => {
        searchQueryRef.current = query;
        const trimmed = query.trim();

        if (!trimmed) {
          allHitsRef.current = [];
          visibleHitsRef.current = [];
          currentHitIndexRef.current = -1;
          setTempExpandedBlockId(null);
          updateHighlightsAndNotches('', [], -1);

          searchStateRef.current = EMPTY_SEARCH_STATE;
          onSearchStateChange?.(EMPTY_SEARCH_STATE);
          return EMPTY_SEARCH_STATE;
        }

        // 1. 文档顺序匹配所有块（若 query 未改变则直接复用缓存的 allHits）
        let allHits: BlockHit[];
        if (trimmed === lastTrimmedQueryRef.current && allHitsRef.current.length > 0) {
          allHits = allHitsRef.current;
        } else {
          allHits = [];
          for (const block of blocks) {
            const plainText = plainTextCacheRef.current.get(block);
            const matches = findMatchesInText(plainText, trimmed);
            matches.forEach((m, matchIdx) => {
              allHits.push({
                blockId: block.id,
                blockOrder: block.order,
                blockIncluded: block.included,
                matchIndex: matchIdx,
                startOffset: m.startOffset,
                endOffset: m.endOffset,
              });
            });
          }
          allHitsRef.current = allHits;
          lastTrimmedQueryRef.current = trimmed;
        }

        // 2. 根据当前筛选过滤可见命中
        const isVisible = (included: boolean) => {
          if (currentFilter === 'all') return true;
          if (currentFilter === 'included') return included;
          if (currentFilter === 'excluded') return !included;
          return true;
        };

        const visibleHits = allHits.filter((h) => isVisible(h.blockIncluded));
        const hiddenHits = allHits.filter((h) => !isVisible(h.blockIncluded));
        visibleHitsRef.current = visibleHits;

        let hiddenHitsFilter: 'excluded' | 'included' | null = null;
        if (hiddenHits.length > 0) {
          hiddenHitsFilter = currentFilter === 'included' ? 'excluded' : 'included';
        }

        // 3. 计算当前活动命中索引
        let nextHitIndex = -1;
        if (visibleHits.length > 0) {
          if (typeof targetHitIndex === 'number') {
            nextHitIndex = Math.max(0, Math.min(targetHitIndex, visibleHits.length - 1));
          } else if (currentHitIndexRef.current >= 0 && currentHitIndexRef.current < visibleHits.length) {
            nextHitIndex = currentHitIndexRef.current;
          } else {
            nextHitIndex = 0;
          }
        }
        currentHitIndexRef.current = nextHitIndex;

        const newState: SearchState = {
          query,
          totalHits: visibleHits.length,
          currentHitIndex: nextHitIndex,
          hiddenHitsCount: hiddenHits.length,
          hiddenHitsFilter,
        };
        searchStateRef.current = newState;
        onSearchStateChange?.(newState);

        // 4. 更新高亮与活动状态
        if (options?.highlight !== false) {
          updateHighlightsAndNotches(query, visibleHits, nextHitIndex);
        }
        if (options?.scroll !== false && nextHitIndex >= 0 && visibleHits[nextHitIndex]) {
          activateHit(visibleHits[nextHitIndex], trimmed);
        }

        return newState;
      },
      [blocks, onSearchStateChange, updateHighlightsAndNotches, activateHit]
    );

    // 序号定位：读取 ref 中的最新 blocks 与筛选，供切换筛选后的 effect 调用时不受闭包过期影响
    const locateOrder = useCallback((n: number): OrderLocateResult => {
      const curBlocks = blocksRef.current;
      const curFilter = filterRef.current;
      const total = curBlocks.length;
      const targetBlock = Number.isInteger(n) ? curBlocks.find((b) => b.order === n) : undefined;
      if (!targetBlock) {
        return { status: 'out_of_range', totalBlocks: total };
      }

      const isVisible =
        curFilter === 'all' ||
        (curFilter === 'included' && targetBlock.included) ||
        (curFilter === 'excluded' && !targetBlock.included);

      if (!isVisible) {
        return {
          status: 'hidden_by_filter',
          totalBlocks: total,
          targetOrder: n,
          targetBlockId: targetBlock.id,
          hiddenInFilter: targetBlock.included ? 'included' : 'excluded',
        };
      }

      const el = itemRefs.current.get(targetBlock.id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.focus();
      }

      return {
        status: 'success',
        totalBlocks: total,
        targetOrder: n,
        targetBlockId: targetBlock.id,
      };
    }, []);

    // 筛选切换处理（保持滚动位置与合理焦点）
    const handleFilterChange = useCallback(
      (nextFilter: BlockFilterMode, thenLocateOrder?: number) => {
        if (nextFilter === filter) {
          if (thenLocateOrder !== undefined) locateOrder(thenLocateOrder);
          return;
        }

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

        if (!isControlledFilter) {
          setInternalFilter(nextFilter);
        }
        onFilterChange?.(nextFilter);
        if (thenLocateOrder !== undefined) {
          pendingLocateOrderRef.current = thenLocateOrder;
        }

        // 重新计算搜索状态（切换筛选保持阅读位置与滚动状态，不强制滚向首个命中）。
        // 此刻新筛选下的块尚未挂载，高亮与刻痕交由渲染后的 effect 重建
        if (searchQueryRef.current) {
          executeSearch(searchQueryRef.current, nextFilter, undefined, {
            scroll: false,
            highlight: false,
          });
        }

        // 若聚焦块在新筛选下不可见，平稳转移焦点：下一个可见块 -> 上一个 -> 筛选页签
        if (activeBlockId && !nextVisible.some((b) => b.id === activeBlockId)) {
          const oldIndex = blocks.findIndex((b) => b.id === activeBlockId);
          const nextTarget =
            nextVisible.find((b) => b.order > (blocks[oldIndex]?.order ?? 0)) ||
            nextVisible[nextVisible.length - 1];

          setTimeout(() => {
            if (nextTarget) {
              const el = itemRefs.current.get(nextTarget.id);
              if (el) {
                el.focus({ preventScroll: true });
              }
            } else {
              // 列表为空时回到筛选页签
              onFocusFallbackRef.current?.(filterRef.current);
            }
          }, 0);
        }
      },
      [blocks, filter, isControlledFilter, onFilterChange, executeSearch, locateOrder]
    );

    // 块取舍切换处理（在筛选视图下剔除/恢复导致块从视图消失时，焦点平稳前移）
    const handleToggleBlock = useCallback(
      (blockId: string) => {
        const curBlocks = blocksRef.current;
        const curFilter = filterRef.current;
        const curVisible = visibleBlocksRef.current;
        const toggledBlock = curBlocks.find((b) => b.id === blockId);
        const wasCurrentHit =
          currentHitIndexRef.current >= 0 &&
          visibleHitsRef.current[currentHitIndexRef.current]?.blockId === blockId;

        if (curFilter === 'all') {
          dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId } });
          return;
        }

        // 在「保留」/「剔除」视图下切换当前块会使其从视图消失：焦点前移到列表中下一个可见块
        const currentIndex = curVisible.findIndex((b) => b.id === blockId);
        let nextFocusId: string | null = null;
        if (currentIndex !== -1) {
          if (currentIndex + 1 < curVisible.length) {
            nextFocusId = curVisible[currentIndex + 1].id;
          } else if (currentIndex > 0) {
            nextFocusId = curVisible[currentIndex - 1].id;
          }
        }

        dispatch({ type: 'TOGGLE_BLOCK', payload: { blockId } });

        // 当前命中被取舍移出视图时，自动改指向它后面最近的一处命中
        if (wasCurrentHit && toggledBlock) {
          setTimeout(() => {
            const nextHits = visibleHitsRef.current;
            const nearestAfterIdx = nextHits.findIndex((h) => h.blockOrder > toggledBlock.order);
            const targetIdx = nearestAfterIdx !== -1 ? nearestAfterIdx : Math.max(0, nextHits.length - 1);
            if (targetIdx >= 0 && targetIdx < nextHits.length) {
              currentHitIndexRef.current = targetIdx;
              updateHighlightsAndNotches(searchQueryRef.current, nextHits, targetIdx);
              activateHit(nextHits[targetIdx], searchQueryRef.current.trim());
            }
          }, 0);
        }

        setTimeout(() => {
          if (nextFocusId) {
            const el = itemRefs.current.get(nextFocusId);
            if (el) el.focus();
          } else {
            // 列表空了就回到筛选页签
            onFocusFallbackRef.current?.(filterRef.current);
          }
        }, 0);
      },
      [dispatch, updateHighlightsAndNotches, activateHit]
    );

    // 块更新（重新缓存纯文本，外部 blocks 引用更新会触发下方 useEffect 重新搜索）
    const handleUpdateBlock = useCallback(
      (blockId: string, editedMarkdown: string | null) => {
        plainTextCacheRef.current.invalidate(blockId);
        dispatch({ type: 'UPDATE_BLOCK', payload: { blockId, editedMarkdown } });
      },
      [dispatch]
    );

    // 仅当 blocks 属性发生实质变更时重新搜索，避免 filter 切换时重复全量搜索；更新时不移动视口保持编辑位置。
    // 高亮由下方 effect 统一重建（blocks 变更必然带来 visibleBlocks 变更）
    useEffect(() => {
      if (prevBlocksRef.current !== blocks) {
        prevBlocksRef.current = blocks;
        lastTrimmedQueryRef.current = '';
        if (searchQueryRef.current) {
          executeSearch(searchQueryRef.current, filter, undefined, {
            scroll: false,
            highlight: false,
          });
        }
      }
    }, [blocks, filter, executeSearch]);

    // 可见块集合（筛选切换、blocks 变更）或临时展开变更并完成挂载后，按新 DOM 重建高亮与页边刻痕
    useEffect(() => {
      if (searchQueryRef.current.trim()) {
        updateHighlightsAndNotches(
          searchQueryRef.current,
          visibleHitsRef.current,
          currentHitIndexRef.current
        );
      }
    }, [visibleBlocks, tempExpandedBlockId, updateHighlightsAndNotches]);

    // 切换筛选时指定了待定位序号：新筛选下的块挂载完成后再滚动与聚焦
    useEffect(() => {
      const pending = pendingLocateOrderRef.current;
      if (pending !== null) {
        pendingLocateOrderRef.current = null;
        locateOrder(pending);
      }
    }, [visibleBlocks, locateOrder]);

    // 跳转到指定命中，越界时循环到另一端并返回 wrapped
    const gotoHit = useCallback(
      (index: number): { wrapped: boolean } => {
        const hits = visibleHitsRef.current;
        if (hits.length === 0) return { wrapped: false };

        let targetIdx = index;
        let wrapped = false;
        if (targetIdx >= hits.length) {
          targetIdx = 0;
          wrapped = true;
        } else if (targetIdx < 0) {
          targetIdx = hits.length - 1;
          wrapped = true;
        }

        currentHitIndexRef.current = targetIdx;
        const updatedState: SearchState = { ...searchStateRef.current, currentHitIndex: targetIdx };
        searchStateRef.current = updatedState;
        onSearchStateChange?.(updatedState);

        updateHighlightsAndNotches(searchQueryRef.current, hits, targetIdx);
        activateHit(hits[targetIdx], searchQueryRef.current.trim());

        return { wrapped };
      },
      [onSearchStateChange, updateHighlightsAndNotches, activateHit]
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
          const vBottom = typeof window !== 'undefined' ? window.innerHeight : 800;
          // 低于固定顶栏的区域才算可见：顶栏实际高度经 scroll-margin-top 下发到块条目（见 app.css）
          let vTop = 0;

          for (const [id, el] of itemRefs.current.entries()) {
            if (vTop === 0) {
              vTop = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
            }
            const rect = el.getBoundingClientRect();
            if (rect.bottom > vTop && rect.top < vBottom) {
              visibleIds.push(id);
            }
          }
          return visibleIds;
        },
        setFilter: (f: BlockFilterMode, options?: { thenLocateOrder?: number }) =>
          handleFilterChange(f, options?.thenLocateOrder),
        getFilter: () => filter,
        getFocusedBlockId: (): string | null => {
          const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
          if (!activeEl) return null;
          for (const [id, el] of itemRefs.current.entries()) {
            if (el === activeEl || el.contains(activeEl)) {
              return id;
            }
          }
          return null;
        },
        restoreFocus: (id: string | null) => {
          if (!id) return;
          const el = itemRefs.current.get(id);
          if (el) {
            el.focus({ preventScroll: true });
          }
        },

        // 搜索实现
        search: (query: string): SearchState => {
          return executeSearch(query, filter);
        },

        clearSearch: () => {
          executeSearch('', filter);
        },

        gotoHit,

        gotoNextHit: (): { wrapped: boolean } => gotoHit(currentHitIndexRef.current + 1),

        gotoPrevHit: (): { wrapped: boolean } => gotoHit(currentHitIndexRef.current - 1),

        locateOrder,

        // Esc 交还焦点：命中在编辑中的块时交给 textarea，已设好的选区随之显现
        focusCurrentHitBlock: () => {
          const hits = visibleHitsRef.current;
          const idx = currentHitIndexRef.current;
          if (idx >= 0 && idx < hits.length) {
            const hit = hits[idx];
            const el = itemRefs.current.get(hit.blockId);
            if (el) {
              const textarea = el.querySelector('textarea');
              (textarea ?? el).focus();
            }
          }
        },

        getSearchState: () => searchStateRef.current,

        getCounts: () => ({
          total: totalCount,
          included: includedCount,
          excluded: excludedCount,
        }),
      }),
      [
        filter,
        totalCount,
        includedCount,
        excludedCount,
        handleFilterChange,
        executeSearch,
        gotoHit,
        locateOrder,
      ]
    );

    return (
      <div className="block-list" data-testid="block-list">
        {/* 块流汇总条：展示总块数（筛选页签在固定顶栏，Issue #29 §3） */}
        <div className="block-list-summary-bar" data-testid="block-list-summary-bar">
          <div className="summary-title">
            <span className="summary-heading">内容块流</span>
            <span className="summary-total" data-testid="summary-total-blocks">
              共 {totalCount} 块
            </span>
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
                isTempExpanded={tempExpandedBlockId === b.id}
                ref={getRefCallback(b.id)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
);

BlockList.displayName = 'BlockList';
