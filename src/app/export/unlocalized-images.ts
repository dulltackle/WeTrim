import { extractPlainTextFromMarkdown } from '../search/text-search';
import { truncateGraphemes } from '../../shared/grapheme';
import { currentMarkdown, type ArticleSnapshot } from '../../shared/types';
import { stripBoundaryEmptyLines } from './build-markdown';
import type { MarkdownImageAnalysis, ImageSourceRange } from './markdown-image-refs';
import type { FetchedImageFailure } from './fetch-images';

export interface ImageEditTarget extends ImageSourceRange {
  blockId: string;
  order: number;
  summary: string;
}

export interface UnlocalizedImage {
  url: string;
  reason: string;
  canKeepExternal: boolean;
  locations: (ImageEditTarget & { definition?: ImageEditTarget })[];
}

export type ImageDecision = 'cancel' | 'retry' | 'continue';

function usableNetworkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

function failureReason(failure?: FetchedImageFailure): string {
  if (!failure) return '无法保存此图片，请返回编辑检查地址或保留外链继续。';
  switch (failure.reason) {
    case 'outside_scope': return '不在自动下载范围内。仅自动下载已获授权的微信图片。';
    case 'permission': return '尚未获得此微信图片地址的访问权限。';
    case 'http': return failure.status === 403 ? '图片网站拒绝访问（403）。' : `图片网站返回错误（${failure.status}）。`;
    case 'not_image': return '地址返回的内容不是可识别的图片。';
    case 'timeout': return '图片下载超时，请检查网络后重试。';
    default: return '网络连接失败，未能下载图片，请重试。';
  }
}

/** 把合成正文的源位置映射回当前内容，包括被裁去的块边界空行。 */
export function describeUnlocalizedImages(
  snapshot: ArticleSnapshot,
  analysis: MarkdownImageAnalysis,
  localized: Map<string, string>,
  failures: FetchedImageFailure[]
): UnlocalizedImage[] {
  let offset = 0;
  const blocks = snapshot.blocks.filter(b => b.included && currentMarkdown(b).trim()).map(block => {
    const original = currentMarkdown(block);
    const text = stripBoundaryEmptyLines(original);
    const start = offset;
    offset += text.length + 2;
    return { block, text, start, end: start + text.length, prefix: original.indexOf(text) };
  });
  const locate = (range: ImageSourceRange): ImageEditTarget | undefined => {
    const entry = blocks.find(b => range.start >= b.start && range.start < b.end);
    if (!entry) return undefined;
    return {
      blockId: entry.block.id, order: entry.block.order,
      summary: truncateGraphemes(extractPlainTextFromMarkdown(entry.text).replace(/\s+/g, ' ').trim() || '图片引用', 60),
      start: range.start - entry.start + entry.prefix,
      end: Math.min(range.end, entry.end) - entry.start + entry.prefix,
    };
  };
  const result = new Map<string, UnlocalizedImage>();
  for (const usage of analysis.usages) {
    if (usage.canRewrite && localized.has(usage.resolvedUrl)) continue;
    const valid = usableNetworkUrl(usage.resolvedUrl);
    const key = valid ? usage.resolvedUrl : usage.rawUrl;
    let item = result.get(key);
    if (!item) {
      item = {
        url: usage.rawUrl,
        reason: valid ? failureReason(failures.find(f => f.url === usage.resolvedUrl)) : '图片地址无效，没有可用的网络链接。请返回编辑修正。',
        canKeepExternal: valid, locations: [],
      };
      result.set(key, item);
    }
    const target = locate(usage);
    if (target) item.locations.push({ ...target, definition: usage.definition && locate(usage.definition) });
  }
  return [...result.values()];
}
