// ---- 块 ----

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'image'
  | 'code'
  | 'list'
  | 'quote'
  | 'table'
  | 'divider'
  | 'formula'
  | 'richMedia'
  | 'unknown';

/** 转换提示：转换降级或信息丢失时给用户看的辅助信息。不进入导出正文。 */
export interface ConversionNote {
  code: string; // 机器可读，如 'table-degraded' | 'richmedia-placeholder' | 'convert-failed'
  message: string; // 面向用户的中文说明
  imageAssetIds?: string[]; // 与提示相关的图片资源
}

export interface Block {
  id: string; // UUID，首次切分时生成
  order: number; // 顺序单独保存，不用数组下标当身份
  type: BlockType; // 初始类型，编辑不改变，也不重新切块
  originalHtml: string; // 来源记录，不是可直接执行的页面
  initialMarkdown: string; // 首次转换结果，永不变
  editedMarkdown: string | null; // null = 未编辑；'' 是有效编辑
  included: boolean; // 保留 = true
  notes: ConversionNote[];
  headingLevel?: number; // type === 'heading' 时
}

/** 当前内容：editedMarkdown 必须用 ?? 而不是 ||（空字符串是有效编辑） */
export const currentMarkdown = (b: Block): string => b.editedMarkdown ?? b.initialMarkdown;

// ---- 图片 ----

/** 图片资源。与图片块分开建模：一张图可被多个块引用。 */
export interface ImageAsset {
  id: string;
  url: string; // 完整原始 URL（data-src 优先于 src），已按文章 URL 解析为绝对地址
}

// ---- 快照与会话 ----

export interface ArticleSource {
  title: string; // 原始标题，文件名清理不反写这里
  account: string | null;
  publishedAt: string | null; // 'YYYY-MM-DD'，UTC+8 换算，无法可靠解析则 null
  url: string; // 原样保存，不为会话身份删改微信查询参数
}

export interface ArticleSnapshot {
  snapshotId: string;
  capturedAt: string; // ISO
  source: ArticleSource;
  blocks: Block[];
  images: ImageAsset[];
  captureWarnings: ConversionNote[]; // 如「可能没显示完整」
}

export interface Session {
  schemaVersion: number;
  sessionId: string;
  snapshot: ArticleSnapshot;
  revision: number; // 单调递增，防迟到写入覆盖新状态
  savedAt: string;
}

export interface CandidateRecord {
  schemaVersion: number;
  snapshot: ArticleSnapshot;
  savedAt: string;
}

export type CaptureResult =
  | { kind: 'article'; source: ArticleSource; contentHtml: string; unstable: boolean; tabId?: number }
  | { kind: 'wechatNotice'; noticeText: string; articleUrl?: string | null; tabId?: number }
  | { kind: 'captcha'; articleUrl: string | null; tabId?: number }
  | { kind: 'noArticle'; tabId?: number };

export interface PendingCapture {
  capturedAt: string;
  result: CaptureResult;
}
