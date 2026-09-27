/**
 * 依据 PRODUCT.md 「导出」、ARCHITECTURE.md §10 与 Issue #32：
 * 导出文案集中收敛，预留 i18n 接口。
 */
export const EXPORT_COPY = {
  // 顶栏与预览操作按钮
  toolbarExportButton: '导出',
  toolbarExportAriaLabel: '导出清洗结果到本地文件夹',
  previewExportButton: '导出到文件夹',
  previewExportAriaLabel: '导出当前清洗结果到本地文件夹',

  // 正文为空时的拦截提示
  emptyBodyTitle: '没有可导出的正文',
  emptyBodyDesc: '当前所有内容块均已被剔除，或保留的内容块正文均为空，无法导出正文。',

  // 成功反馈
  exportSuccessTitle: '导出完成',
  exportSuccessDesc: (dirName: string, fileName: string): string =>
    `文稿已保存至「${dirName}/${fileName}」。`,
  btnConfirmSuccess: '知道了',

  // 失败反馈（磁盘或权限导致写入失败）
  exportFailedTitle: '导出未完成',
  exportFailedDesc: (attemptedDirName?: string, errorMsg?: string): string =>
    `文件写入未完成${
      attemptedDirName ? `，可能在所选目录下残留未完整文件夹「${attemptedDirName}」` : ''
    }。先前的导出结果未受改动。请检查磁盘空间或文件夹权限后重试。${
      errorMsg ? `（错误详情：${errorMsg}）` : ''
    }`,
  btnConfirmFailed: '知道了',
} as const;
