/**
 * 依据 PRODUCT.md 「导出」与 Issue #32 验收标准：
 * 文件名清理规则：
 * 1. 保留中文与 emoji（按完整字素，不切断肤色修饰符与 ZWJ 序列）
 * 2. 将 / \ : * ? " < > | 与控制字符（0x00-0x1F, 0x7F）替换为下划线 _
 * 3. 清除结尾的点与空格
 * 4. Windows 保留名加前缀下划线（CON, PRN, AUX, NUL, COM1-9, LPT1-9，不区分大小写）
 * 5. 清理后为空用「未命名文章」
 * 6. 基名最多 60 个可见字素并按完整字素截断，同时不超过 180 UTF-8 字节，并对最终组件再校验
 * 7. 纯函数，不反写 ArticleSource.title
 */

const FORBIDDEN_AND_CONTROL_CHARS = /[/\\:*?"<>|\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
export const DEFAULT_ARTICLE_TITLE = '未命名文章';

export function sanitizeArticleTitle(rawTitle?: string | null): string {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return DEFAULT_ARTICLE_TITLE;
  }

  // 1. 替换非法字符与控制字符为下划线
  let name = rawTitle.replace(FORBIDDEN_AND_CONTROL_CHARS, '_');

  // 2. 清除结尾的点与空格
  name = name.replace(/[. ]+$/, '');

  // 若清除后为空（例如原标题全为点、空格或空字符串），使用默认「未命名文章」
  if (!name.trim()) {
    return DEFAULT_ARTICLE_TITLE;
  }

  // 3. Windows 保留名加前缀下划线
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    name = '_' + name;
  }

  // 4. 基名最多 60 个可见字素并按完整字素截断，同时不超过 180 UTF-8 字节
  name = truncateFilenameGraphemesAndBytes(name, 60, 180);

  // 5. 对最终组件再校验：
  // 截断后可能在末尾留下了点或空格
  name = name.replace(/[. ]+$/, '');

  // 若再次为空，回退默认
  if (!name.trim()) {
    name = DEFAULT_ARTICLE_TITLE;
  }

  // 截断后可能恰好变成了 Windows 保留名（例如 "CON.longsuffix" 截断后变成 "CON"）
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    name = '_' + name;
  }

  return name;
}

function truncateFilenameGraphemesAndBytes(
  text: string,
  maxGraphemes: number,
  maxBytes: number
): string {
  const encoder = new TextEncoder();

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let truncated = '';
    let currentBytes = 0;
    let graphemeCount = 0;

    for (const { segment } of segmenter.segment(text)) {
      if (graphemeCount >= maxGraphemes) {
        break;
      }
      const segBytes = encoder.encode(segment).length;
      if (currentBytes + segBytes > maxBytes) {
        break;
      }
      truncated += segment;
      currentBytes += segBytes;
      graphemeCount++;
    }
    return truncated;
  }

  // 兜底（Array.from 遍历码点）
  const chars = Array.from(text);
  let truncated = '';
  let currentBytes = 0;
  let count = 0;

  for (const char of chars) {
    if (count >= maxGraphemes) {
      break;
    }
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > maxBytes) {
      break;
    }
    truncated += char;
    currentBytes += charBytes;
    count++;
  }
  return truncated;
}
