import { Marked, type Token, type Tokens } from 'marked';
import type { Block, ImageAsset } from '../../shared/types';
import { resolveImageUrl, resolveUrlString } from '../parse/rules/wechat';

/**
 * 从内容块中收集图片资源（对应 docs/conversion-rules.md §4.8 与 ARCHITECTURE.md §5）:
 * 1. data-src 有值时优先于 src
 * 2. 原样保留全部查询参数，不归一化尺寸、格式或签名参数
 * 3. 相对地址按文章 URL 解析为绝对地址
 * 4. 按完整 URL 字符串去重（不做内容哈希）
 * 5. wx_fmt 只用于猜扩展名，不修改 URL
 * 6. 支持从富媒体卡片属性（mp-common-profile 头像、mp-common-miniprogram 封面）收集图片资源
 */
export function collectImages(blocks: Block[], baseUrl?: string): ImageAsset[] {
  if (typeof DOMParser === 'undefined') {
    return [];
  }

  const parser = new DOMParser();
  const seenUrls = new Set<string>();
  const imageAssets: ImageAsset[] = [];

  for (const block of blocks) {
    if (!block.originalHtml) {
      continue;
    }

    const html = block.originalHtml;
    const mightHaveImages =
      html.includes('<img') ||
      html.includes('mp-common-profile') ||
      html.includes('mpprofile') ||
      html.includes('mp-common-miniprogram') ||
      html.includes('mp-miniprogram') ||
      html.includes('data-headimg');

    if (!mightHaveImages) {
      continue;
    }

    try {
      const doc = parser.parseFromString(html, 'text/html');

      const addAsset = (rawUrl: string | null) => {
        if (!rawUrl) return;
        const url = resolveUrlString(rawUrl.trim(), baseUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          imageAssets.push({
            id: crypto.randomUUID(),
            url,
          });
        }
      };

      // 1. 标准 <img> 标签
      const imgs = doc.querySelectorAll('img');
      for (const img of Array.from(imgs)) {
        const url = resolveImageUrl(img, baseUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          imageAssets.push({
            id: crypto.randomUUID(),
            url,
          });
        }
      }

      // 2. 公众号名片头像属性（data-headimg, data-headimgurl）
      const profiles = doc.querySelectorAll('mp-common-profile, mpprofile');
      for (const p of Array.from(profiles)) {
        addAsset(p.getAttribute('data-headimg') || p.getAttribute('data-headimgurl'));
      }

      // 3. 小程序卡片封面属性（data-miniprogram-imageurl, data-miniprogram-headimg）
      const miniprograms = doc.querySelectorAll('mp-common-miniprogram, mp-miniprogram');
      for (const mp of Array.from(miniprograms)) {
        addAsset(
          mp.getAttribute('data-miniprogram-imageurl') ||
          mp.getAttribute('data-miniprogram-headimg')
        );
      }
    } catch {
      // 容错：个别块的 DOM 解析失败不中断整篇图片收集
    }
  }

  return imageAssets;
}

export interface ExportImageReference {
  /** 首次出现赋予的编号，从 1 开始 */
  index: number;
  /** 基础文件名前缀，如 image-001, image-002, image-1000 */
  fileBaseName: string;
  /** 在 Markdown 中原始书写的 URL */
  rawUrl: string;
  /** 解析后的绝对网络 URL（去重与下载依据） */
  resolvedUrl: string;
  /** 替代文字 */
  alt: string;
  /** 标题（如有） */
  title?: string;
}

export function formatImageBaseName(index: number): string {
  if (index < 1000) {
    return `image-${String(index).padStart(3, '0')}`;
  }
  return `image-${index}`;
}

/**
 * 依据 Issue #33 与 ARCHITECTURE.md §10.1：
 * 从保留块的当前合成正文中收集有效图片引用：
 * 1. 识别与重写使用与预览一致的 Markdown 解析语义（Marked）
 * 2. 覆盖行内（![alt](url "title")）和引用式图片（![alt][ref]、![ref]）
 * 3. 以合成后的正文处理引用定义，避免逐块正则替换漏掉跨块引用
 * 4. 代码块、行内代码里的相似字符串不当成图片；普通文字超链接不触发下载
 * 5. 命名按第一次有效引用的顺序 image-001、image-002，超过三位自然增长（image-1000）
 * 6. 同一完整 URL 只下载保存一份，所有引用指向同一个文件；相对网络地址以来源文章 URL 解析为绝对；保留查询参数；不同 URL 即使内容相同也不做内容哈希去重
 */
export function collectExportImageReferences(
  markdown: string,
  baseUrl?: string
): ExportImageReference[] {
  if (!markdown || markdown.trim() === '') {
    return [];
  }

  const customMarked = new Marked({
    extensions: [
      {
        name: 'def',
        level: 'block',
        tokenizer(s: string) {
          const rule =
            /^ {0,3}\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$)/;
          const match = rule.exec(s);
          if (match) {
            const tag = match[1].toLowerCase().replace(/\s+/g, ' ');
            const rawHref = match[2] || '';
            const href =
              rawHref.startsWith('<') && rawHref.endsWith('>')
                ? rawHref.slice(1, -1)
                : rawHref;
            let title = match[3];
            if (title) {
              title = title.slice(1, -1);
            }
            const lexerAny = this.lexer as unknown as { tokens: { links: Record<string, unknown> } };
            if (lexerAny.tokens?.links && !lexerAny.tokens.links[tag]) {
              lexerAny.tokens.links[tag] = { href, title };
            }
            return {
              type: 'def',
              raw: match[0],
              tag,
              href,
              title,
            };
          }
        },
      },
    ],
  });

  const tokens = customMarked.lexer(markdown);
  const seenUrls = new Set<string>();
  const references: ExportImageReference[] = [];
  let nextIndex = 1;

  function walkToken(token: Token) {
    if (!token) return;

    if (token.type === 'image') {
      const imgToken = token as Tokens.Image;
      const rawUrl = imgToken.href;
      if (rawUrl) {
        const resolvedUrl = resolveUrlString(rawUrl, baseUrl);
        if (resolvedUrl && !seenUrls.has(resolvedUrl)) {
          seenUrls.add(resolvedUrl);
          const index = nextIndex++;
          references.push({
            index,
            fileBaseName: formatImageBaseName(index),
            rawUrl,
            resolvedUrl,
            alt: imgToken.text || '',
            title: imgToken.title || undefined,
          });
        }
      }
    }

    const withTokens = token as { tokens?: Token[]; items?: Token[] };
    if (Array.isArray(withTokens.tokens)) {
      for (const child of withTokens.tokens) {
        walkToken(child);
      }
    }
    if (Array.isArray(withTokens.items)) {
      for (const item of withTokens.items) {
        walkToken(item);
      }
    }
    if (token.type === 'table') {
      const tableToken = token as Tokens.Table;
      if (Array.isArray(tableToken.header)) {
        for (const cell of tableToken.header) {
          if (Array.isArray(cell.tokens)) {
            for (const child of cell.tokens) {
              walkToken(child);
            }
          }
        }
      }
      if (Array.isArray(tableToken.rows)) {
        for (const row of tableToken.rows) {
          if (Array.isArray(row)) {
            for (const cell of row) {
              if (Array.isArray(cell.tokens)) {
                for (const child of cell.tokens) {
                  walkToken(child);
                }
              }
            }
          }
        }
      }
    }
  }

  for (const token of tokens) {
    walkToken(token);
  }

  return references;
}
