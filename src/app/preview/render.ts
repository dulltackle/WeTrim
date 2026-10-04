import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 依据 ARCHITECTURE.md §6.3：marked + DOMPurify 安全渲染 Markdown
 */
// 禁止 <form>，避免正文里的表单向外提交；<input> 保留给 GFM 任务列表的复选框
const SANITIZE_CONFIG = { USE_PROFILES: { html: true }, FORBID_TAGS: ['form'] };

function getPurifier(): typeof DOMPurify {
  return typeof DOMPurify?.sanitize === 'function' ? DOMPurify : (DOMPurify as unknown as (w: Window) => typeof DOMPurify)(window);
}

export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  return getPurifier().sanitize(rawHtml, SANITIZE_CONFIG);
}

/**
 * 与 renderMarkdown 同一套方言与净化配置，但直接返回净化后的 DOM 片段，
 * 省掉「序列化成字符串 → 再用 DOMParser 解析一遍」的往返，供整篇预览这类大文本使用。
 * 片段留在 DOMPurify 的惰性文档里（未导入当前文档），其中的 <img> 不会提前发起请求。
 */
export function renderMarkdownToFragment(markdown: string): DocumentFragment {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  return getPurifier().sanitize(rawHtml, { ...SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true });
}
