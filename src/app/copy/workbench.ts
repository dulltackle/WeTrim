/**
 * 工作台外壳（顶栏、校样纸头、空态与失败卡片）的界面文案集中收敛，保留未来多语言接口。
 */
export const WORKBENCH_COPY = {
  // 顶栏保存状态
  saveStatus: {
    saving: '正在保存',
    unsaved: '最新更改未保存',
    saved: '已保存',
    error: '保存失败 · 点击重试',
    retryTitle: '点击重新保存',
  },

  // 顶栏票签与系统状态
  ticketTags: {
    cleaning: '校样',
    corrupted: '损坏',
    notice: '退单',
    splitError: '异常',
    empty: '待稿',
  },
  ticketBrand: 'WeTrim',
  systemStatus: {
    cleaning: '正在清洗',
    corrupted: '记录损坏',
    splitError: '整篇解析异常',
    notice: '等待处置',
    ready: '工作台就绪',
  },
  navAriaLabel: '文稿清洗导航与查找工具',
  filterTabsAriaLabel: '内容块筛选',

  // 非模态夹签
  noArticleClipNote: '刚才那个页面上没有公众号文章，你的进度没有被动过',
  closeClipNoteAria: '关闭提示',

  // 校样纸头
  unstableBadge: '批注',
  unstableNote: '文章可能还没显示完整，可以回到原文等它加载完再重新抓一次',
  slipKicker: '文稿录入单',
  untitledArticle: '无标题文章',
  accountLabel: '公众号：',
  publishedAtLabel: '发布时间：',

  // 通用操作
  returnToOriginal: '回到原文看看',
  retry: '重试',
  restart: '重新开始',

  // 损坏记录
  corruptedStamp: '损坏',
  corruptedSub: '存储记录异常',
  corruptedTitle: '暂时无法恢复上次清洗进度',
  corruptedIncompleteDetails: '存储中的清洗会话记录格式不完整或损坏',
  corruptedFallbackDetails: '检测到无法识别或损坏的清洗会话记录。',
  corruptedTip: '原记录已妥善保留未被静默清空。',

  // 整篇级失败
  splitErrorStamp: '异常',
  splitErrorSub: '整篇级失败',
  splitErrorTitle: '无法切分文章正文块',
  splitErrorDetails: (message: string) =>
    `无法从当前页面解析出正文内容（${message}）。请回到原文看看页面是否完整加载，然后重试。`,

  // 微信提示页 / 验证页
  noticeStamp: '退单',
  noticeSub: '审校退单记录',
  captchaTitle: '微信需要安全验证',
  wechatNoticeTitle: '微信页面返回提示',
  captchaDetails:
    '微信需要安全验证。请回到原文标签页完成滑块验证后，再点图标重试。WeTrim 不代替你完成验证。',
  quoteNotice: (text: string) => `“${text}”`,

  // 空状态
  emptyHeadline: '从一篇公众号文章开始',
  emptyStepsMarkdown:
    '1. **用浏览器打开一篇公众号文章**\n2. **等它显示完**\n3. **点工具栏上的 WeTrim 图标** 开始清洗',

  // 导出
  exportBusy: '已有导出正在进行',
};
