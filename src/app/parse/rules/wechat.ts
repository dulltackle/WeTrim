import type TurndownService from 'turndown';
import { registerCodeRules } from './code';
import { registerListRules } from './list';
import { registerQuoteRules } from './quote';


export interface WechatRulesOptions {
  baseUrl?: string;
}

/**
 * 解析图片 URL（对应 docs/conversion-rules.md §4.8）：
 * 1. data-src 有值时优先于 src
 * 2. 原样保留全部查询参数（不清洗尺寸、格式或签名参数）
 * 3. 相对地址按文章 URL 解析为绝对地址
 * 4. wx_fmt 只用于猜扩展名，不在此修改 URL
 */
export function resolveImageUrl(img: Element, baseUrl?: string): string {
  const dataSrc = img.getAttribute('data-src')?.trim();
  const src = img.getAttribute('src')?.trim();
  const rawUrl = dataSrc || src || '';
  if (!rawUrl) return '';

  if (baseUrl) {
    try {
      return new URL(rawUrl, baseUrl).href;
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

/**
 * 清洗属性文本中的多余换行与首尾空白
 */
function cleanAttribute(text: string): string {
  return text ? text.replace(/(\n+\s*)+/g, ' ').trim() : '';
}

/**
 * 微信通用转换规则装配函数
 */
export function registerWechatRules(
  service: TurndownService,
  options?: WechatRulesOptions
): void {
  const baseUrl = options?.baseUrl;

  // 1. <span leaf="">、<span textstyle=""> 当透明容器处理（docs/conversion-rules.md §1.2）
  service.addRule('wechatSpanContainers', {
    filter: (node) => {
      if (node.nodeName === 'SPAN') {
        return node.hasAttribute('leaf') || node.hasAttribute('textstyle');
      }
      return false;
    },
    replacement: (content) => content,
  });

  // 2. 图片规则（docs/conversion-rules.md §4.8）
  // data-src 优先，完整保留参数，相对地址解析为绝对，alt 属性转义方括号
  service.addRule('wechatImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const url = resolveImageUrl(el, baseUrl);
      if (!url) return '';
      const rawAlt = cleanAttribute(el.getAttribute('alt') || '');
      const alt = rawAlt.replace(/[[\]]/g, '\\$&');
      const title = cleanAttribute(el.getAttribute('title') || '');
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
      return `![${alt}](${url}${titlePart})`;
    },
  });

  // 3. 链接规则：保留文字，相对地址按 baseUrl 解析为绝对
  service.addRule('wechatLink', {
    filter: (node, turndownOptions) => {
      return (
        turndownOptions.linkStyle === 'inlined' &&
        node.nodeName === 'A' &&
        Boolean(node.getAttribute('href'))
      );
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const rawHref = el.getAttribute('href') || '';
      let href = rawHref;
      if (baseUrl && rawHref) {
        try {
          href = new URL(rawHref, baseUrl).href;
        } catch {
          href = rawHref;
        }
      }
      const title = cleanAttribute(el.getAttribute('title') || '');
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
      return `[${content}](${href}${titlePart})`;
    },
  });

  // 4. 代码块规则：官方 .code-snippet__fix 形态与第三方 pre > code 形态（docs/conversion-rules.md §4.4）
  registerCodeRules(service);

  // 5. 列表规则：li > p 行内处理，避免多余空行破坏列表（docs/conversion-rules.md §4.5）
  registerListRules(service);

  // 6. 引用块规则：多段落引用、引用套列表与图片随块呈现（docs/conversion-rules.md §4.6 与 Issue #21）
  registerQuoteRules(service);


  // 注：富媒体元素（mp-common-profile, mp-common-miniprogram, mpvoice, video_iframe 等）
  // 因无文本子节点会被 Turndown isBlank 提前丢弃，统一由 convert.ts 中的 prepareRichMediaPlaceholders
  // 在送入 Turndown 前预转换为具名占位节点（避免重复逻辑与空内容丢失）。
}
