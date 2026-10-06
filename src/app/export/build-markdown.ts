import type { ArticleSnapshot, ArticleSource, Block } from '../../shared/types';
import { currentMarkdown } from '../../shared/types';

/**
 * 依据 Issue #31 与 ARCHITECTURE.md §10.3：
 * 判断是否为空时用 trim，输出时保留原文，只去掉块首尾的空行。
 * 块内部的换行、缩进、硬换行与代码原样保留。
 * 高性能指针扫描实现，避免在 600 块长文下产生大量正则表达式引擎开销。
 */
export function stripBoundaryEmptyLines(text: string): string {
  if (!text) return '';
  const len = text.length;

  // 1. 扫描块开头的空行（纯空白字符加换行）
  let start = 0;
  while (start < len) {
    let p = start;
    let isBlank = true;
    while (p < len && text.charCodeAt(p) !== 10 && text.charCodeAt(p) !== 13) {
      const code = text.charCodeAt(p);
      if (code !== 32 && code !== 9) {
        isBlank = false;
        break;
      }
      p++;
    }
    if (!isBlank) break;
    while (p < len && (text.charCodeAt(p) === 10 || text.charCodeAt(p) === 13)) {
      p++;
    }
    if (p === start) break;
    start = p;
  }

  // 2. 扫描块末尾的空行（换行加纯空白字符）
  let end = len;
  while (end > start) {
    let p = end - 1;
    let isBlank = true;
    while (p >= start && text.charCodeAt(p) !== 10 && text.charCodeAt(p) !== 13) {
      const code = text.charCodeAt(p);
      if (code !== 32 && code !== 9) {
        isBlank = false;
        break;
      }
      p--;
    }
    if (!isBlank) break;
    while (p >= start && (text.charCodeAt(p) === 10 || text.charCodeAt(p) === 13)) {
      p--;
    }
    end = p + 1;
  }

  if (start >= end) return '';
  return text.slice(start, end);
}

/**
 * 清洗结果（GLOSSARY.md、ARCHITECTURE.md §10.3 与 Issue #31）：
 * 按文章原顺序汇集保留块的当前内容所得的正文；剔除块与空白块不进入结果。
 * 块边界用一个空行连接，块内部缩进与换行原样保留。
 */
export function buildMarkdown(blocks: Block[]): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.included) continue;
    const md = currentMarkdown(b);
    if (!md || md.trim() === '') continue;
    parts.push(stripBoundaryEmptyLines(md));
  }
  return parts.join('\n\n');
}

/**
 * YAML 标量字符串格式化与转义（ARCHITECTURE.md §10.3 与 Issue #31）：
 * 按引号、冒号、换行正确转义。
 * 当字符串包含引号、冒号、换行、#、制表符或首尾空白等特殊字符，或裸写会被解析为数字/布尔/null 时，采用双引号并标准转义。
 */
// 裸写会被 YAML 解析成数字、布尔值、日期或 null 的标量（YAML 1.1 与 1.2 的并集），必须加引号保持字符串
const YAML_NON_STRING_SCALAR =
  /^(?:[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d+)(?:e[-+]?\d+)?|\d{4}-\d\d?-\d\d?(?:[t ].*)?|0x[\da-f_]+|0o[0-7_]+|[-+]?\.(?:inf)|\.nan|true|false|yes|no|y|n|on|off|null|~)$/i;

export function formatYamlString(value: string): string {
  const needsQuotes =
    value === '' ||
    /[:"'#\n\r\t]|^[\s\-?:,[\]{}#&*!|>'"%@`]|[\s]$/.test(value) ||
    YAML_NON_STRING_SCALAR.test(value);
  if (needsQuotes) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * front-matter 日期字段解析与 UTC+8 校验（PRODUCT.md 与 Issue #31）：
 * 固定四字段之一，按 UTC+8 硬编码换算，解析不了就省略（返回 null）。
 * 抓取端 extractDate 已把发布日期规整为 YYYY-MM-DD，走的是第 1 支；
 * 其余分支是防御性保留，兜住旧会话记录或将来抓取格式变化，保证任何输入都不随导出设备时区跨日。
 */
export function parseFrontMatterDate(val: string | null | undefined): string | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  // 1. 若为 YYYY-MM-DD 或 YYYY/MM/DD 纯日期格式，验证其日历合法性并返回 YYYY-MM-DD
  const mDateOnly = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (mDateOnly) {
    const year = parseInt(mDateOnly[1], 10);
    const month = parseInt(mDateOnly[2], 10);
    const day = parseInt(mDateOnly[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const testDate = new Date(Date.UTC(year, month - 1, day));
      if (
        testDate.getUTCFullYear() === year &&
        testDate.getUTCMonth() === month - 1 &&
        testDate.getUTCDate() === day
      ) {
        return `${mDateOnly[1]}-${mDateOnly[2]}-${mDateOnly[3]}`;
      }
    }
    return null;
  }

  // 2. 若为不带时区偏移的日期时间格式（如微信文章常见的 "2026-09-26 20:00:00"），
  //    因其为发布地（UTC+8）时间，直接提取其年月日并校验日历有效性，严防宿主机本地时区污染导致跨日
  const mDateTimeNoTz = trimmed.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (mDateTimeNoTz) {
    const year = parseInt(mDateTimeNoTz[1], 10);
    const month = parseInt(mDateTimeNoTz[2], 10);
    const day = parseInt(mDateTimeNoTz[3], 10);
    const hour = parseInt(mDateTimeNoTz[4], 10);
    const min = parseInt(mDateTimeNoTz[5], 10);
    const sec = mDateTimeNoTz[6] ? parseInt(mDateTimeNoTz[6], 10) : 0;
    if (
      month >= 1 && month <= 12 &&
      day >= 1 && day <= 31 &&
      hour >= 0 && hour <= 23 &&
      min >= 0 && min <= 59 &&
      sec >= 0 && sec <= 59
    ) {
      const testDate = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
      if (
        testDate.getUTCFullYear() === year &&
        testDate.getUTCMonth() === month - 1 &&
        testDate.getUTCDate() === day
      ) {
        return `${mDateTimeNoTz[1]}-${mDateTimeNoTz[2]}-${mDateTimeNoTz[3]}`;
      }
    }
    return null;
  }

  // 3. 若为纯数字时间戳（10 位秒或 13 位毫秒），换算为 UTC+8 的 YYYY-MM-DD
  if (/^\d{10}(\d{3})?$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    const ms = trimmed.length === 10 ? num * 1000 : num;
    const d = new Date(ms + 8 * 3600 * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  // 4. 若为带明确时区标识的标准 ISO-8601 字符串（如包含 Z 或 +08:00 等），
  //    解析得到绝对时刻（不受宿主机本地时区影响），再换算为 UTC+8 的 YYYY-MM-DD
  const mIsoWithTz = trimmed.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/i
  );
  if (mIsoWithTz) {
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return null;
    const utc8Date = new Date(d.getTime() + 8 * 3600 * 1000);
    return utc8Date.toISOString().slice(0, 10);
  }

  // 无法可靠解析则按验收标准省略该字段
  return null;
}

/**
 * 顶部 YAML front-matter 构建（PRODUCT.md、ARCHITECTURE.md §10.3 与 Issue #31）：
 * 固定四字段 title / account / date / source，未知值省略，不输出空占位。
 * 若四个字段均为空或未知，返回空字符串。
 */
export function buildFrontMatter(source?: ArticleSource | null): string {
  if (!source) return '';
  const lines: string[] = [];

  // 1. title: 未知值省略，不输出空占位
  if (source.title && source.title.trim() !== '') {
    lines.push(`title: ${formatYamlString(source.title.trim())}`);
  }

  // 2. account: 未知值省略，不输出空占位
  if (source.account && source.account.trim() !== '') {
    lines.push(`account: ${formatYamlString(source.account.trim())}`);
  }

  // 3. date: 按 UTC+8 换算，解析不了就省略
  const dateStr = parseFrontMatterDate(source.publishedAt);
  if (dateStr) {
    lines.push(`date: ${dateStr}`);
  }

  // 4. source: 未知值省略，不输出空占位
  if (source.url && source.url.trim() !== '') {
    lines.push(`source: ${formatYamlString(source.url.trim())}`);
  }

  if (lines.length === 0) {
    return '';
  }

  return `---\n${lines.join('\n')}\n---`;
}

export interface ResultFile {
  frontMatter: string;
  body: string;
  text: string;
}

/**
 * 检查结果合成文件（Issue #31 与 Issue #32 共用方言模块）：
 * - frontMatter: 顶部 YAML 头部，四字段按规则转义与省略；无有效字段时为空字符串
 * - body: 正文 Markdown，仅保留块非空内容，块边界空行连接，内部缩进原样保留
 * - text: 完整输出文件（front-matter + 空行 + 正文 + 末尾换行）；正文为空时不创建只含来源信息的文件
 */
export function buildResultFile(snapshot: ArticleSnapshot): ResultFile {
  const frontMatter = buildFrontMatter(snapshot.source);
  const body = buildMarkdown(snapshot.blocks);
  return { frontMatter, body, text: composeResultText(frontMatter, body) };
}

/** 结果文件全文：front matter 与正文之间空一行，末尾一个换行；正文为空时不产出只含来源信息的文件 */
export function composeResultText(frontMatter: string, body: string): string {
  if (!body) return '';
  return frontMatter ? `${frontMatter}\n\n${body}\n` : `${body}\n`;
}
