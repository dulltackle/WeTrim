/**
 * 字素（Grapheme Cluster）处理工具
 * 遵循现代 Unicode 规范（Intl.Segmenter），按完整字素截断文本，不切断 emoji、变音符号及复合字符序列。
 */

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function truncateGraphemes(text: string, maxGraphemes = 20, ellipsis = '...'): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }

  if (graphemeSegmenter && maxGraphemes >= 0) {
    // 摘要只需要前 N 个字素及一个溢出标志，不扫描整段长文。
    let result = '';
    let count = 0;
    for (const { segment } of graphemeSegmenter.segment(clean)) {
      if (count++ >= maxGraphemes) return result + ellipsis;
      result += segment;
    }
    return result;
  }

  // 环境无 Intl.Segmenter 时的兜底：使用 Array.from 避免拆散双字节代理对
  const chars = Array.from(clean);
  if (chars.length <= maxGraphemes) {
    return clean;
  }
  return chars.slice(0, maxGraphemes).join('') + ellipsis;
}
