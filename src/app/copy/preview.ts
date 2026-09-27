/**
 * 依据 Issue #31 与设计简报：
 * 检查结果汇总预览文案集中管理，不硬编码在组件中。
 */
export const PREVIEW_COPY = {
  // 顶栏入口
  openButton: '检查结果',
  openButtonAria: '打开检查结果汇总预览',

  // 对话框头部
  dialogTitle: '检查结果',
  closeButton: '关闭',
  closeButtonAria: '关闭预览并返回清洗 (Esc)',

  // 统计
  statsWithEmpty: (includedCount: number, emptyCount: number): string =>
    `保留 ${includedCount} 块（另有 ${emptyCount} 块保留但内容为空，未计入）`,
  statsWithoutEmpty: (includedCount: number): string =>
    `保留 ${includedCount} 块`,

  // 视图切换
  tabsAriaLabel: '预览视图切换',
  tabReading: '阅读预览',
  tabSource: 'Markdown 源码',

  // 降级汇总条
  degradationSummaryLabel: '转换降级汇总',
  degradationItemCount: (typeLabel: string, count: number): string => `${typeLabel} ${count} 处`,
  degradationTypeLabels: {
    'table-degraded': '表格降级',
    'richmedia-placeholder': '富媒体占位',
    'convert-failed': '未知内容',
    fallback: '转换降级',
  } as Record<string, string>,
  toggleDegradationExpand: '展开降级列表',
  toggleDegradationCollapse: '收起降级列表',
  jumpToDegradationBlockAria: (order: number, type: string): string =>
    `定位至第 ${order} 块（${type}）`,

  // 稿头字段（阅读预览）
  headerKicker: '成稿清样',
  accountPrefix: '公众号：',
  datePrefix: '发布时间：',
  sourcePrefix: '来源：',

  // 空正文状态
  emptyTitle: '没有可导出的正文',
  emptyReasonAllExcluded: '当前所有内容块均已被剔除，无法导出正文。',
  emptyReasonAllEmpty: '保留的内容块正文均为空，无法导出正文。',
  btnRecoverExcluded: '去找回剔除的块',
  btnJumpToFirstEmpty: '跳到第一个空块',

  // 底部操作区
  btnReturnToCleaning: '返回清洗',
};
