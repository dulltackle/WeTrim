import { analyzeMarkdownImages } from './markdown-image-refs';

/**
 * 依据 Issue #33 与 ARCHITECTURE.md §10.1：
 * 把导出副本里成功本地化的图片引用改写为 images/… 相对路径，其余文本逐字不动。
 * 识别范围与 collectExportImageReferences 完全相同（共用 analyzeMarkdownImages），
 * 代码块、行内代码、普通文字超链接都不会被改写。
 */
export function rewriteMarkdownImagePaths(
  markdown: string,
  localizedUrlMap: Map<string, string>,
  baseUrl?: string
): string {
  if (!markdown || localizedUrlMap.size === 0) {
    return markdown;
  }
  return analyzeMarkdownImages(markdown, baseUrl).rewrite(localizedUrlMap);
}
