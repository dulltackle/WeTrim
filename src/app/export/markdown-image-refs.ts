import { Lexer, Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';
import { resolveUrlString } from '../parse/rules/wechat';

/**
 * 依据 Issue #33 与 ARCHITECTURE.md §10.1：
 * 导出图片的「收集」与「改写」共用这一次分析，保证两者对同一份正文看到的是同一批图片引用。
 *
 * 1. 解析语义与预览一致：同为 marked 默认方言（gfm），不改写 marked 的任何规则；
 *    唯一的扩展只是把「本来就会被 marked 登记的引用定义」作为 token 留在树里，好知道它在源文中的位置。
 * 2. 代码块、行内代码、HTML 片段里的相似字符串不会成为 image token，自然不收集也不改写。
 * 3. 改写只动图片自己的目的地址：行内图片改 `(…)` 里的地址；引用式图片改定义行的地址。
 *    若同一条定义还被普通文字链接引用，改定义会连带改掉链接，此时改为把这一处图片写成行内形式，定义保持原样。
 * 4. 源文位置由「按 token 顺序在源文中逐行定位 raw」得到：嵌套在引用块、列表里的 token 的 raw 去掉了 `> `
 *    或缩进前缀，但每一行仍是源文某一行的后缀，所以逐行定位依然成立；定位不到的图片不进入导出集合，
 *    避免下载了却改写不到、留下孤立文件。
 */

export interface ExportImageReference {
  /** 首次出现赋予的编号，从 1 开始 */
  index: number;
  /** 基础文件名前缀，如 image-001, image-002, image-1000 */
  fileBaseName: string;
  /** marked 解析出的地址（已去掉尖括号与反斜杠转义） */
  rawUrl: string;
  /** 解析后的绝对网络 URL（去重与下载依据） */
  resolvedUrl: string;
  /** 替代文字 */
  alt: string;
  /** 标题（如有） */
  title?: string;
}

export interface MarkdownImageAnalysis {
  references: ExportImageReference[];
  /** 按「完整 URL → 本地相对路径」改写导出副本；不在映射里的引用保持原样 */
  rewrite(localizedUrlMap: Map<string, string>): string;
}

export function formatImageBaseName(index: number): string {
  if (index < 1000) {
    return `image-${String(index).padStart(3, '0')}`;
  }
  return `image-${index}`;
}

const BLOCK_RULES = Lexer.rules.block.normal;
const INLINE_RULES = Lexer.rules.inline.normal;
const DEF_TOKEN_TYPE = 'wetrimReferenceDefinition';

interface ReferenceDefinitionToken {
  type: typeof DEF_TOKEN_TYPE;
  raw: string;
  tag: string;
  /** 这条定义是否就是 marked 实际采用的那条（同名定义只认第一条） */
  registered: boolean;
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').toLowerCase();
}

function unescapePunctuation(text: string): string {
  return text.replace(INLINE_RULES.anyPunctuation, '$1');
}

/**
 * 与 marked 内置 def 分支同一条规则、同一套登记逻辑：
 * 前一个 token 是段落或文本时交还内置分支（它会把这行并进段落，不当定义），其余情况由这里登记并留下 token。
 */
const referenceDefinitionExtension: TokenizerExtension = {
  name: DEF_TOKEN_TYPE,
  level: 'block',
  tokenizer(src, tokens) {
    const cap = BLOCK_RULES.def.exec(src);
    if (!cap) return undefined;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') return undefined;

    const tag = normalizeLabel(cap[1]);
    const links = this.lexer.tokens.links;
    const registered = !links[tag];
    if (registered) {
      links[tag] = {
        href: cap[2] ? unescapePunctuation(cap[2].replace(/^<(.*)>$/, '$1')) : '',
        title: cap[3] ? unescapePunctuation(cap[3].slice(1, -1)) : cap[3],
      };
    }
    const token: ReferenceDefinitionToken = { type: DEF_TOKEN_TYPE, raw: cap[0], tag, registered };
    return token as unknown as Tokens.Generic;
  },
};

const analysisMarked = new Marked({ extensions: [referenceDefinitionExtension] });

/** raw 内偏移 → 源文偏移；raw 的每一行在源文中定位到的起点，定位不到记为 -1 */
class RawLocation {
  constructor(
    private readonly lines: string[],
    private readonly sourceStarts: number[]
  ) {}

  toSource(rawOffset: number): number | null {
    let lineStart = 0;
    for (let k = 0; k < this.lines.length; k++) {
      const lineEnd = lineStart + this.lines[k].length;
      if (rawOffset <= lineEnd) {
        const start = this.sourceStarts[k];
        return start === -1 ? null : start + (rawOffset - lineStart);
      }
      lineStart = lineEnd + 1;
    }
    return null;
  }

  /** raw 中 [start, end) 映射到源文且仍是连续同一段时返回源文区间 */
  toSourceRange(start: number, end: number): { start: number; end: number } | null {
    const s = this.toSource(start);
    const e = this.toSource(end);
    if (s === null || e === null || e - s !== end - start) return null;
    return { start: s, end: e };
  }
}

class SourceCursor {
  position = 0;

  constructor(private readonly source: string) {}

  /** 从当前位置起逐行定位 raw，并把位置推进到 raw 末尾 */
  consume(raw: string): RawLocation {
    const lines = raw.split('\n');
    const starts: number[] = [];
    for (const line of lines) {
      const found = line === '' ? this.position : this.source.indexOf(line, this.position);
      starts.push(found);
      if (found !== -1) {
        this.position = found + line.length;
      }
    }
    return new RawLocation(lines, starts);
  }
}

interface TextEdit {
  start: number;
  end: number;
  resolvedUrl: string;
  render: (localPath: string) => string;
}

interface ImageOccurrence {
  token: Tokens.Image;
  resolvedUrl: string;
  /** 行内图片：目的地址的替换 */
  destinationEdit?: TextEdit;
  /** 引用式图片 */
  referenceTag?: string;
  /** 引用式图片整体改写为行内形式的替换（定义被文字链接共用时使用） */
  inlineConversionEdit?: TextEdit;
}

interface LocatedDefinition {
  destinationEdit: TextEdit | null;
}

function skipDestinationWhitespace(raw: string, i: number): number {
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n')) i++;
  return i;
}

/** 行内链接 / 图片 `[label](dest …)` 中目的地址在 raw 内的区间（尖括号形式只取括号内） */
function findInlineDestination(raw: string): { start: number; end: number } | null {
  const cap = INLINE_RULES.link.exec(raw);
  if (!cap) return null;
  let i = (raw.startsWith('!') ? 2 : 1) + cap[1].length;
  if (raw[i] !== ']' || raw[i + 1] !== '(') return null;
  i = skipDestinationWhitespace(raw, i + 2);

  if (raw[i] === '<') {
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j] === '\\') {
        j++;
      } else if (raw[j] === '>') {
        return j > i + 1 ? { start: i + 1, end: j } : null;
      }
    }
    return null;
  }

  // 与 marked 一致：地址到空白或未配对的右括号为止
  let depth = 0;
  let j = i;
  while (j < raw.length) {
    const c = raw[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '(') depth++;
    if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  return j > i ? { start: i, end: Math.min(j, raw.length) } : null;
}

/** 引用式链接 / 图片 `[label][ref]`、`[label][]`、`[label]` 的标签 */
function parseReference(raw: string): { tag: string; label: string } | null {
  if (raw.endsWith(')')) return null;
  const cap = INLINE_RULES.reflink.exec(raw) ?? INLINE_RULES.nolink.exec(raw);
  if (!cap || cap[0] !== raw) return null;
  return { tag: normalizeLabel(cap[2] || cap[1]), label: cap[1] };
}

/** 引用定义 `[ref]: dest "title"` 中目的地址在 raw 内的区间 */
function findDefinitionDestination(raw: string): { start: number; end: number } | null {
  const cap = BLOCK_RULES.def.exec(raw);
  if (!cap || !cap[2]) return null;
  const indent = raw.length - raw.trimStart().length;
  let i = indent + 1 + cap[1].length;
  if (raw[i] !== ']' || raw[i + 1] !== ':') return null;
  i = skipDestinationWhitespace(raw, i + 2);
  const dest = cap[2];
  if (raw.slice(i, i + dest.length) !== dest) return null;
  return dest.startsWith('<') && dest.endsWith('>')
    ? { start: i + 1, end: i + dest.length - 1 }
    : { start: i, end: i + dest.length };
}

function escapeTitle(title: string): string {
  return title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function childTokensOf(token: Token): Token[] {
  if (token.type === 'list') {
    return (token as Tokens.List).items as Token[];
  }
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    const cells = [...table.header, ...table.rows.flat()];
    return cells.flatMap((cell) => cell.tokens ?? []);
  }
  const children = (token as { tokens?: Token[] }).tokens;
  return Array.isArray(children) ? children : [];
}

export function analyzeMarkdownImages(markdown: string, baseUrl?: string): MarkdownImageAnalysis {
  if (!markdown || markdown.trim() === '') {
    return { references: [], rewrite: () => markdown };
  }

  const tokens = analysisMarked.lexer(markdown);
  const cursor = new SourceCursor(markdown);
  const occurrences: ImageOccurrence[] = [];
  const definitions = new Map<string, LocatedDefinition>();
  const linkReferenceTags = new Set<string>();

  const visitImage = (token: Tokens.Image) => {
    const location = cursor.consume(token.raw);
    if (!token.href) return;
    const resolvedUrl = resolveUrlString(token.href, baseUrl);
    if (!resolvedUrl) return;

    const reference = parseReference(token.raw);
    if (!reference) {
      const dest = findInlineDestination(token.raw);
      const range = dest && location.toSourceRange(dest.start, dest.end);
      if (range) {
        occurrences.push({
          token,
          resolvedUrl,
          destinationEdit: { ...range, resolvedUrl, render: (localPath) => localPath },
        });
      }
      return;
    }

    const whole = location.toSourceRange(0, token.raw.length);
    const titleSuffix = token.title ? ` "${escapeTitle(token.title)}"` : '';
    occurrences.push({
      token,
      resolvedUrl,
      referenceTag: reference.tag,
      inlineConversionEdit:
        whole && !token.raw.includes('\n')
          ? {
              ...whole,
              resolvedUrl,
              render: (localPath) => `![${reference.label}](${localPath}${titleSuffix})`,
            }
          : undefined,
    });
  };

  const visitDefinition = (token: ReferenceDefinitionToken) => {
    const location = cursor.consume(token.raw);
    if (!token.registered) return;
    const link = tokens.links[token.tag];
    const resolvedUrl = link?.href ? resolveUrlString(link.href, baseUrl) : '';
    const dest = findDefinitionDestination(token.raw);
    const range = dest && location.toSourceRange(dest.start, dest.end);
    definitions.set(token.tag, {
      destinationEdit:
        range && resolvedUrl ? { ...range, resolvedUrl, render: (localPath) => localPath } : null,
    });
  };

  const visit = (token: Token) => {
    if (token.type === 'image') {
      visitImage(token as Tokens.Image);
      return;
    }
    if (token.type === DEF_TOKEN_TYPE) {
      visitDefinition(token as unknown as ReferenceDefinitionToken);
      return;
    }
    if (token.type === 'link') {
      const reference = parseReference(token.raw);
      if (reference) linkReferenceTags.add(reference.tag);
    }

    // 先按顺序定位子 token（图片可能在其中），再回到起点整体消费本 token，保证游标停在它的末尾
    const start = cursor.position;
    const children = childTokensOf(token);
    if (children.length > 0) {
      children.forEach(visit);
      cursor.position = start;
    }
    cursor.consume(token.raw);
  };

  tokens.forEach(visit);

  // 为每处图片确定改写方式；改写不了的图片不进入导出集合
  const edits: TextEdit[] = [];
  const usedDefinitionEdits = new Set<TextEdit>();
  const rewritable: ImageOccurrence[] = [];
  for (const occurrence of occurrences) {
    let edit = occurrence.destinationEdit;
    if (occurrence.referenceTag !== undefined) {
      const definitionEdit = definitions.get(occurrence.referenceTag)?.destinationEdit;
      edit =
        definitionEdit && !linkReferenceTags.has(occurrence.referenceTag)
          ? definitionEdit
          : occurrence.inlineConversionEdit;
    }
    if (!edit) continue;
    rewritable.push(occurrence);
    if (!usedDefinitionEdits.has(edit)) {
      usedDefinitionEdits.add(edit);
      edits.push(edit);
    }
  }

  const seenUrls = new Set<string>();
  const references: ExportImageReference[] = [];
  for (const { token, resolvedUrl } of rewritable) {
    if (seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);
    const index = references.length + 1;
    references.push({
      index,
      fileBaseName: formatImageBaseName(index),
      rawUrl: token.href,
      resolvedUrl,
      alt: token.text || '',
      title: token.title || undefined,
    });
  }

  edits.sort((a, b) => a.start - b.start);

  return {
    references,
    rewrite(localizedUrlMap) {
      if (localizedUrlMap.size === 0) return markdown;
      let result = '';
      let last = 0;
      for (const edit of edits) {
        const localPath = localizedUrlMap.get(edit.resolvedUrl);
        if (!localPath) continue;
        result += markdown.slice(last, edit.start) + edit.render(localPath);
        last = edit.end;
      }
      return result + markdown.slice(last);
    },
  };
}
