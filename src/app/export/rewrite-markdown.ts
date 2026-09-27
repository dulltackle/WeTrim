import { Marked } from 'marked';
import { resolveUrlString } from '../parse/rules/wechat';

/**
 * 依据 Issue #33 与 ARCHITECTURE.md §10.1：
 * 识别与重写使用与预览一致的 Markdown 解析语义：
 * 1. 覆盖行内（![alt](url "title")）和引用式图片定义（[ref]: url "title"）
 * 2. 代码块（fenced 或 indented）、行内代码（`...`）中的假图片绝不当成图片，100% 保持不变
 * 3. 普通超链接 [text](url) 不被改写，正文普通 URL 不被改写
 * 4. 导出的 .md 与预览「Markdown 源码」视图的唯一差异是成功本地化的图片 URL 改写为 images/…，其余文本逐字一致
 */
export function rewriteMarkdownImagePaths(
  markdown: string,
  localizedUrlMap: Map<string, string>,
  baseUrl?: string
): string {
  if (!markdown || localizedUrlMap.size === 0) {
    return markdown;
  }

  const customMarked = new Marked({
    extensions: [
      {
        name: 'def',
        level: 'block',
        tokenizer(s: string) {
          const rule =
            /^ {0,3}\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$)/;
          const match = rule.exec(s);
          if (match) {
            const tag = match[1].toLowerCase().replace(/\s+/g, ' ');
            const rawHref = match[2] || '';
            const href =
              rawHref.startsWith('<') && rawHref.endsWith('>')
                ? rawHref.slice(1, -1)
                : rawHref;
            let title = match[3];
            if (title) {
              title = title.slice(1, -1);
            }
            const lexerAny = this.lexer as unknown as { tokens: { links: Record<string, unknown> } };
            if (lexerAny.tokens?.links && !lexerAny.tokens.links[tag]) {
              lexerAny.tokens.links[tag] = { href, title };
            }
            return {
              type: 'def',
              raw: match[0],
              tag,
              href,
              title,
            };
          }
        },
      },
    ],
  });

  const tokens = customMarked.lexer(markdown);
  let result = '';

  function rewriteNonCodeChunk(chunk: string): string {
    let out = '';
    let i = 0;
    const len = chunk.length;

    while (i < len) {
      // 1. 行内代码 `...` 或 ```...```：原样跳过，防止误伤其中的代码内容
      if (chunk[i] === '`') {
        let tickCount = 1;
        while (i + tickCount < len && chunk[i + tickCount] === '`') {
          tickCount++;
        }
        const openTicks = '`'.repeat(tickCount);
        const closeIdx = chunk.indexOf(openTicks, i + tickCount);
        if (closeIdx !== -1) {
          const endIdx = closeIdx + tickCount;
          out += chunk.slice(i, endIdx);
          i = endIdx;
          continue;
        } else {
          out += openTicks;
          i += tickCount;
          continue;
        }
      }

      // 2. 引用定义行：[ref]: url "title"
      // 必须位于行首（前面为换行或字符串开头，允许 0-3 个空格缩进）
      if (
        (chunk[i] === '[' || (chunk[i] === ' ' && /^[ ]{1,3}\[/.test(chunk.slice(i)))) &&
        (i === 0 || chunk[i - 1] === '\n')
      ) {
        const sub = chunk.slice(i);
        const defMatch =
          /^( {0,3}\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]: *(?:\n[ \t]*)?)([^<\s][^\s]*|<.*?>)((?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$))/.exec(
            sub
          );
        if (defMatch) {
          const prefix = defMatch[1];
          const rawHref = defMatch[3];
          const suffix = defMatch[4];
          const isAngleBracket = rawHref.startsWith('<') && rawHref.endsWith('>');
          const cleanHref = isAngleBracket ? rawHref.slice(1, -1) : rawHref;
          const resolvedHref = resolveUrlString(cleanHref, baseUrl);

          const newRelative =
            localizedUrlMap.get(resolvedHref) || localizedUrlMap.get(cleanHref);

          if (newRelative) {
            const replacementHref = isAngleBracket ? `<${newRelative}>` : newRelative;
            out += prefix + replacementHref + suffix;
            i += defMatch[0].length;
            continue;
          }
        }
      }

      // 3. 行内图片：![alt](url "title")
      // 必须以 ![ 开头，且前一个字符不能是 \ 转义符
      if (chunk[i] === '!' && chunk[i + 1] === '[' && (i === 0 || chunk[i - 1] !== '\\')) {
        const sub = chunk.slice(i);
        const imgMatch =
          /^(!\[((?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?)\]\(\s*)(<(?:\\.|[^\n<>\\])+>|(?:[^ \t\n\x00-\x1f()]|\([^\s()]*\))*)((\s*(?:(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\)))?\s*)\))/.exec(
            sub
          );
        if (imgMatch) {
          const prefix = imgMatch[1];
          const rawHref = imgMatch[3];
          const suffix = imgMatch[4];
          const isAngleBracket = rawHref.startsWith('<') && rawHref.endsWith('>');
          const cleanHref = isAngleBracket ? rawHref.slice(1, -1) : rawHref;
          const resolvedHref = resolveUrlString(cleanHref, baseUrl);

          const newRelative =
            localizedUrlMap.get(resolvedHref) || localizedUrlMap.get(cleanHref);

          if (newRelative) {
            const replacementHref = isAngleBracket ? `<${newRelative}>` : newRelative;
            out += prefix + replacementHref + suffix;
            i += imgMatch[0].length;
            continue;
          }
        }
      }

      out += chunk[i];
      i++;
    }

    return out;
  }

  for (const token of tokens) {
    if (token.type === 'code') {
      result += token.raw;
    } else {
      result += rewriteNonCodeChunk(token.raw);
    }
  }

  return result;
}
