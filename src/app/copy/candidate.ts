/**
 * 依据 Issue #28 与设计简报：
 * 换稿通知单文案集中管理，预留 i18n。
 */
export const CANDIDATE_COPY = {
  stamp: '待确认',
  noticeSub: '换稿通知单',
  noticeTitle: '检测到新文章',
  newArticleLabel: '新稿',
  oldArticleLabel: '旧稿',
  defaultArticleTitle: '无标题文章',
  accountPrefix: '公众号：',
  totalBlockCount: (count: number) => `共 ${count} 块`,
  captureTimePrefix: '抓取时间：',
  lastSavedPrefix: '最后保存：',
  excludedCount: (count: number) => `剔除 ${count} 块`,
  editedCount: (count: number) => `编辑 ${count} 块`,
  unstableNote: '文章可能还没显示完整',
  unstableBadge: '批注',
  btnContinue: '继续当前清洗',
  btnReplace: '清除旧进度，换成这篇',
  btnReturnToOriginal: '回到原文看看',
  replaceFailed: '替换没有完成，当前清洗没有被动过',
  candidateSaveFailed: '新文章没保存下来，当前清洗没有被动过',
  readingArticleStatus: '正在读取新文章…',
  waitingConfirmStatus: '等待确认',
  ticketCandidateTag: '候选',
  formatLossNotice: (options: {
    isSameUrl: boolean;
    oldTitle: string;
    excludedCount: number;
    editedCount: number;
  }): string => {
    if (options.isSameUrl) {
      return '这是同一篇文章的新抓取。替换后按新内容重新开始，之前的剔除和编辑不会带过来。';
    }
    if (options.excludedCount === 0 && options.editedCount === 0) {
      return `《${options.oldTitle}》还没有剔除或编辑。`;
    }
    const parts: string[] = [];
    if (options.excludedCount > 0) {
      parts.push(`剔除的 ${options.excludedCount} 块`);
    }
    if (options.editedCount > 0) {
      parts.push(`编辑的 ${options.editedCount} 块`);
    }
    return `替换后，你在《${options.oldTitle}》里${parts.join('、')}会被清除。`;
  },
};
