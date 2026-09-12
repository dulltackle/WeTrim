import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 依据 ARCHITECTURE.md §6.3：marked + DOMPurify 安全渲染 Markdown
 */
export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  const purifier = typeof DOMPurify?.sanitize === 'function' ? DOMPurify : (DOMPurify as unknown as (w: Window) => typeof DOMPurify)(window);
  return purifier.sanitize(rawHtml);
}
