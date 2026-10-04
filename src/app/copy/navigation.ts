/**
 * 依据 Issue #29 设计简报 §7：
 * 搜索、定位、导航与顶栏工具文案集中收敛，保留未来多语言接口。
 */
export const NAVIGATION_COPY = {
  searchPlaceholder: '搜索正文...',
  searchAriaLabel: '搜索文章当前可见内容',
  clearSearch: '清除搜索',
  clearSearchAriaLabel: '清除搜索内容',
  prevHit: '上一处',
  prevHitAriaLabel: '上一处命中 (Shift+Enter)',
  nextHit: '下一处',
  nextHitAriaLabel: '下一处命中 (Enter)',
  hitCountDisplay: (current: number, total: number) => `${current} / ${total}`,
  hitCountAria: (current: number, total: number) => `第 ${current} 处，共 ${total} 处`,
  notFound: (query: string) => `没有找到「${query}」`,
  wrappedToFirst: '已回到第一处',
  otherHitsInExcluded: (count: number) => `另有 ${count} 处在已剔除块中`,
  otherHitsInIncluded: (count: number) => `另有 ${count} 处在保留块中`,
  switchToAll: '切到「全部」',
  jumpPlaceholder: '跳至 #',
  jumpAriaLabel: '跳至指定序号',
  jumpBtn: '跳转',
  totalBlocksOutOfRange: (total: number) => `共 ${total} 块`,
  targetBlockExcluded: (order: number) => `第 ${order} 块已被剔除，当前筛选下看不到`,
  targetBlockIncluded: (order: number) => `第 ${order} 块已被保留，当前筛选下看不到`,
  switchToAllAndJump: '切到「全部」并跳过去',
  returnToOriginal: '回到原文看看',
  filterAll: (count: number) => `全部 ${count}`,
  filterIncluded: (count: number) => `保留 ${count}`,
  filterExcluded: (count: number) => `剔除 ${count}`,
} as const;
