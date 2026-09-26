/**
 * 依据 Issue #30 与设计简报：
 * 图片呈现层与转换提示文案集中管理，预留 i18n。
 */
export const IMAGE_COPY = {
  defaultImageAlt: '图片',
  loadFailed: '图片没有加载出来',
  retry: '重试',
  retrying: '正在重试…',
  loading: '图片加载中',
  tallBadge: '长图',
  tallBadgeFull: '长图 · 点击看原图',
  tallAriaLabel: '长图，点击查看完整原图',
  viewerTitle: '查看原图',
  viewerClose: '关闭',
  viewerCloseAria: '关闭原图 (Esc)',
  openViewerAria: (alt: string): string => `查看原图: ${alt || '图片'}`,
  retryAria: (label: string): string => `重试加载图片: ${label || '图片'}`,
};

export const NOTES_COPY = {
  shortBadges: {
    'table-degraded': '降级',
    'richmedia-placeholder': '占位',
    'convert-failed': '未转换',
    fallback: '提示',
  } as Record<string, string>,
  badgeAria: (code: string): string =>
    `转换提示: ${NOTES_COPY.shortBadges[code] || NOTES_COPY.shortBadges.fallback}`,
};
