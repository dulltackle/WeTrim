/**
 * 依据 PRODUCT.md 「导出」、ARCHITECTURE.md §10 与 Issue #32：
 * 导出文案集中收敛，预留 i18n 接口。
 */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
  exportSuccessDesc: (
    dirName: string,
    fileName: string,
    images?: { localized: number; failed: number }
  ): string => {
    let desc = `文稿已保存至「${dirName}/${fileName}」。`;
    if (images && images.localized > 0) {
      desc += `${images.localized} 张图片已保存到 images/ 文件夹。`;
    }
    if (images && images.failed > 0) {
      desc += `另有 ${images.failed} 张图片下载失败，文稿中仍保留其原网络地址。`;
    }
    return desc;
  },
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
  imageWriteFailed: (errorMsg: string): string => `写入图片文件未完成：${errorMsg}`,

  // 图片下载
  imageDownloadTimeout: '图片下载超时',
  // 进度按实际收到的字节累计，张数只说明完成到哪一张，不用来估算百分比
  exportProgress: (completedCount: number, totalCount: number, downloadedBytes: number): string =>
    `正在下载图片 ${completedCount}/${totalCount} · 已接收 ${formatByteSize(downloadedBytes)}`,

  // 目录选择本身失败（非用户取消）：尚未写入任何内容
  pickFailedTitle: '无法选择文件夹',
  pickFailedDesc: (errorMsg?: string): string =>
    `没能打开或使用所选文件夹，本次没有写入任何内容。${
      errorMsg ? `（错误详情：${errorMsg}）` : ''
    }`,
  stampSuccess: '印毕',
  stampError: '未完',
  stampEmpty: '空白',
  dialogCloseAria: '关闭提示',
} as const;
