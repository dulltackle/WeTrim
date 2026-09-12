import type TurndownService from 'turndown';

/**
 * 装配微信引用块转换规则（docs/conversion-rules.md §4.6，ADR-0001 与 Issue #21）
 *
 * 1. 整段 blockquote 成一个引用块的 Markdown
 * 2. 行内格式与链接保留（由通用行内与链接规则协同保证）
 * 3. 多段落引用中段落间空行规范保留 `> ` 前缀，确保整体成 1 个连续引用块
 * 4. 引用套列表整体成 1 个引用块，内部列表在引用内正确缩进
 * 5. 引用内部的图片随块呈现，不产生独立的图片块
 */
export function registerQuoteRules(service: TurndownService): void {
  service.addRule('wechatBlockquote', {
    filter: 'blockquote',
    replacement: (content) => {
      // 1. 修整首尾空白，若内容为空则短路返回空串，触发单块级降级保护
      content = content.trim();
      if (!content) return '';

      // 2. 规范连续换行与空段落（如 <p><br></p> 或连续空行残留）
      content = content.replace(/^[ \t]+$/gm, '');
      content = content.replace(/\n{3,}/g, '\n\n');

      // 3. 确保每一行（包括段落间的空行）都正确保留 `> ` 前缀
      content = content.replace(/^/gm, '> ');
      return '\n\n' + content + '\n\n';
    },
  });
}
