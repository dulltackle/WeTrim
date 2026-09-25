import { renderMarkdown } from '../preview/render';
import type { Block } from '../../shared/types';
import { currentMarkdown } from '../../shared/types';

export interface MatchLocation {
  startOffset: number;
  endOffset: number;
}

export interface BlockHit {
  blockId: string;
  blockOrder: number;
  blockIncluded: boolean;
  matchIndex: number; // 0-indexed match within this block
  startOffset: number;
  endOffset: number;
}

export interface SearchState {
  query: string;
  totalHits: number;
  currentHitIndex: number; // 0-indexed, or -1 if no hits
  hiddenHitsCount: number;
  hiddenHitsFilter: 'excluded' | 'included' | null;
}

export const EMPTY_SEARCH_STATE: SearchState = {
  query: '',
  totalHits: 0,
  currentHitIndex: -1,
  hiddenHitsCount: 0,
  hiddenHitsFilter: null,
};

/**
 * 依据 Issue #29 设计简报 §5：
 * 匹配规则：只在当前内容（editedMarkdown ?? initialMarkdown）里用户能看到的文字上匹配，
 * Markdown 符号和链接、图片地址不参与。不区分大小写，按字面匹配。计数和高亮必须一致。
 */
export function extractPlainTextFromMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';

  if (typeof document !== 'undefined') {
    try {
      const html = renderMarkdown(markdown);
      const doc = document.implementation.createHTMLDocument('');
      doc.body.innerHTML = html;
      return doc.body.textContent || '';
    } catch {
      // 降级使用正则清洗
    }
  }

  // 纯文本环境降级（剥离 Markdown 语法符号与图片/链接地址，图片不贡献正文文字）
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 剥离 Markdown 图片标记
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 剥离链接 URL 保留链接文字
    .replace(/^#{1,6}\s+/gm, '') // 剥离标题前缀 #
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 剥离加粗
    .replace(/(\*|_)(.*?)\1/g, '$2') // 剥离斜体
    .replace(/~~(.*?)~~/g, '$1') // 剥离删除线
    .replace(/`([^`]+)`/g, '$1') // 剥离行内代码
    .replace(/^>\s*/gm, '') // 剥离引用前缀 >
    .replace(/^[-*+]\s+/gm, '') // 剥离无序列表前缀
    .replace(/^\d+\.\s+/gm, '') // 剥离有序列表前缀
    .replace(/<[^>]+>/g, '') // 剥离 HTML 标签
    .replace(/^={2,}/gm, '')
    .replace(/^-{2,}/gm, '');
}

/**
 * 块纯文本缓存：按内容缓存，内容变了才重新计算（Issue #29 §7）
 */
export class BlockPlainTextCache {
  private cache = new Map<string, { markdown: string; plainText: string }>();

  get(block: Block): string {
    const md = currentMarkdown(block);
    const existing = this.cache.get(block.id);
    if (existing && existing.markdown === md) {
      return existing.plainText;
    }
    const plainText = extractPlainTextFromMarkdown(md);
    this.cache.set(block.id, { markdown: md, plainText });
    return plainText;
  }

  invalidate(blockId: string) {
    this.cache.delete(blockId);
  }
}

/**
 * 大小写折叠且保证长度不变：个别字符（如 `İ`）转小写后长度会变，
 * 直接 toLowerCase 会让匹配偏移与原文错位，这类字符保留原样。
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = '';
  for (const ch of text) {
    const lc = ch.toLowerCase();
    folded += lc.length === ch.length ? lc : ch;
  }
  return folded;
}

/**
 * 字面匹配查找所有非重叠位置（不区分大小写）
 */
export function findMatchesInText(plainText: string, query: string): MatchLocation[] {
  if (!query || !query.trim() || !plainText) return [];
  const matches: MatchLocation[] = [];
  const lowerText = foldCase(plainText);
  const lowerQuery = foldCase(query);
  const queryLen = lowerQuery.length;
  let fromIndex = 0;

  while (fromIndex < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, fromIndex);
    if (idx === -1) break;
    matches.push({
      startOffset: idx,
      endOffset: idx + queryLen,
    });
    fromIndex = idx + queryLen;
  }
  return matches;
}

/**
 * 在容器节点的 Text 节点树上为指定的字符偏移区间构建 DOM Range。
 * 能够精确穿透 <strong>, <em>, <a> 等行内 DOM 标签，支持跨节点 Range。
 */
export function createRangeForOffsets(
  container: Node,
  startOffset: number,
  endOffset: number
): Range | null {
  if (typeof document === 'undefined') return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let currentOffset = 0;
  let startNode: Node | null = null;
  let startNodeOffset = 0;
  let endNode: Node | null = null;
  let endNodeOffset = 0;

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textLen = node.nodeValue?.length || 0;
    const nodeStart = currentOffset;
    const nodeEnd = currentOffset + textLen;

    if (!startNode) {
      if (startOffset >= nodeStart && (startOffset < nodeEnd || (startOffset === nodeEnd && textLen === 0))) {
        startNode = node;
        startNodeOffset = startOffset - nodeStart;
      }
    }

    if (!endNode) {
      if (endOffset >= nodeStart && endOffset <= nodeEnd) {
        endNode = node;
        endNodeOffset = endOffset - nodeStart;
      }
    }

    if (startNode && endNode) {
      break;
    }
    currentOffset = nodeEnd;
  }

  // 边界保护：若 startOffset 恰好位于最后一个 text 节点的末尾
  if (startNode && !endNode && endOffset >= currentOffset) {
    endNode = startNode;
    endNodeOffset = startNode.nodeValue?.length || 0;
  }

  if (startNode && endNode) {
    try {
      const range = document.createRange();
      range.setStart(startNode, startNodeOffset);
      range.setEnd(endNode, endNodeOffset);
      return range;
    } catch (err) {
      console.warn('[WeTrim Search] Failed to create range:', err);
      return null;
    }
  }
  return null;
}

/**
 * Markdown 源码里不会渲染成可见文字的区间：图片整体、链接地址 `](url)`、HTML 标签（自动链接除外）。
 */
function collectInvisibleSourceRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [/!\[[^\]]*\]\([^)]*\)/g, /\]\([^)]*\)/g, /<(?!https?:)[^>\n]+>/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown))) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

/**
 * 编辑中的块：把「可见文字上的第 matchIndex 处匹配」换算为 textarea 中 Markdown 源码的选区。
 * 命中计数基于渲染后的纯文本，源码里夹着 `**`、链接地址等符号，不能直接在源码上数第 n 处。
 * 做法：将纯文本中的非空白字符按顺序贪心对齐到源码中可见区间的同一字符，得到偏移映射。
 * 匹配跨越行内符号时（如 `**a**b` 搜「ab」），选区覆盖中间的符号。
 * 超出可见匹配数时取最后一处；无法对齐时返回 null。
 */
export function locateVisibleMatchInMarkdown(
  markdown: string,
  query: string,
  matchIndex: number
): { start: number; end: number } | null {
  const plainText = extractPlainTextFromMarkdown(markdown);
  const matches = findMatchesInText(plainText, query.trim());
  if (matches.length === 0) return null;
  const match = matches[Math.min(Math.max(matchIndex, 0), matches.length - 1)];

  const invisible = new Uint8Array(markdown.length);
  for (const [from, to] of collectInvisibleSourceRanges(markdown)) {
    invisible.fill(1, from, to);
  }

  const lastPlainIdx = match.endOffset - 1;
  let sourceStart = -1;
  let cursor = 0;
  for (let i = 0; i <= lastPlainIdx; i++) {
    const ch = plainText[i];
    if (/\s/.test(ch)) continue;
    let j = cursor;
    while (j < markdown.length && (invisible[j] || markdown[j] !== ch)) j++;
    // 源码里找不到该字符（如 `&lt;` 解码而来的 `<`）：跳过它，不推进游标
    if (j >= markdown.length) {
      if (i === match.startOffset || i === lastPlainIdx) return null;
      continue;
    }
    if (i === match.startOffset) sourceStart = j;
    if (i === lastPlainIdx) {
      return sourceStart === -1 ? null : { start: sourceStart, end: j + 1 };
    }
    cursor = j + 1;
  }
  return null;
}
