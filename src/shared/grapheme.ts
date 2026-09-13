/**
 * 字素（Grapheme Cluster）处理工具
 * 遵循现代 Unicode 规范（Intl.Segmenter），按完整字素截断文本，不切断 emoji、变音符号及复合字符序列。
 */

export function truncateGraphemes(text: string, maxGraphemes = 20, ellipsis = '...'): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(clean));
    if (segments.length <= maxGraphemes) {
      return clean;
    }
    return segments.slice(0, maxGraphemes).map((s) => s.segment).join('') + ellipsis;
  }

  // 环境无 Intl.Segmenter 时的兜底：使用 Array.from 避免拆散双字节代理对
  const chars = Array.from(clean);
  if (chars.length <= maxGraphemes) {
    return clean;
  }
  return chars.slice(0, maxGraphemes).join('') + ellipsis;
}
