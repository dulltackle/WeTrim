import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type {
  ArticleSnapshot,
  Block,
  CaptureResult,
  ConversionNote,
} from '../../shared/types';
import { collectImages } from '../export/collect-images';
import { splitBlocks } from './split-blocks';
import { registerWechatRules, type WechatRulesOptions } from './rules/wechat';
import { isTableDegraded } from './rules/table';

/**
 * 装配 Turndown 转换基座与微信通用规则（对应 ARCHITECTURE.md §6.1 与 docs/conversion-rules.md §1、§4.8）
 */
export function createTurndown(options?: WechatRulesOptions): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  // 装配 GFM 插件（表格、删除线、任务列表）
  turndown.use(gfm);

  // 装配微信规则（透明 span、图片 data-src 与绝对地址解析、链接、富媒体占位）
  registerWechatRules(turndown, options);

  return turndown;
}

export interface ConvertBlockOptions {
  baseUrl?: string;
  turndownService?: TurndownService;
}

/**
 * 将属性承载的富媒体元素转为占位节点（对应 docs/conversion-rules.md §4.10）
 * 微信的公众号名片、小程序卡片等内容全部在属性中，内部无文本节点，
 * Turndown 会视其为 isBlank 并在规则匹配前丢弃。
 * 在转入 Turndown 前将富媒体属性提取为可读占位文本节点。
 */
export function prepareRichMediaPlaceholders(html: string): string {
  if (
    !html.includes('mp-common-') &&
    !html.includes('mpprofile') &&
    !html.includes('video_iframe') &&
    !html.includes('mpvoice')
  ) {
    return html;
  }

  if (typeof DOMParser === 'undefined') {
    return html;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 处理公众号名片
    const profiles = doc.querySelectorAll('mp-common-profile, mpprofile');
    profiles.forEach((el) => {
      const name =
        el.getAttribute('data-nickname') ||
        el.getAttribute('data-alias') ||
        el.getAttribute('data-pluginname') ||
        '';
      const placeholder = doc.createElement('span');
      placeholder.textContent = name ? `【公众号】${name}` : '【公众号名片】';
      el.replaceWith(placeholder);
    });

    // 处理小程序
    const miniprograms = doc.querySelectorAll('mp-common-miniprogram, mp-miniprogram');
    miniprograms.forEach((el) => {
      const title =
        el.getAttribute('data-miniprogram-title') ||
        el.getAttribute('data-miniprogram-nickname') ||
        '';
      const placeholder = doc.createElement('span');
      placeholder.textContent = title ? `【小程序】${title}` : '【小程序】';
      el.replaceWith(placeholder);
    });

    // 处理音频
    const audios = doc.querySelectorAll('mpvoice, mp-common-mpaudio');
    audios.forEach((el) => {
      const name = el.getAttribute('name') || el.getAttribute('data-name') || '';
      const placeholder = doc.createElement('span');
      placeholder.textContent = name ? `【音频】${name}` : '【音频】';
      el.replaceWith(placeholder);
    });

    // 处理视频
    const videos = doc.querySelectorAll('iframe.video_iframe, mpvideosnap, mp-common-videosnap');
    videos.forEach((el) => {
      const title = el.getAttribute('data-title') || el.getAttribute('title') || '';
      const placeholder = doc.createElement('span');
      placeholder.textContent = title ? `【视频】${title}` : '【视频】';
      el.replaceWith(placeholder);
    });

    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

/**
 * 独立转换单个内容块，并提供单块级失败的降级处理（对应 ADR-0007 与 ARCHITECTURE.md §6.2）
 *
 * 硬约束：每个内容块独立转换，绝不整篇拼接后再回填占位符。
 * 块内部的换行原样保留，首尾 Turndown 引入的多余换行做适当修整。
 *
 * 单块级失败触发条件（ARCHITECTURE.md §6.2）：
 * 1. 转换过程抛出异常
 * 2. 原始 HTML 非空，却转出空内容
 * 降级行为：
 * - block.type 降为 'unknown'
 * - block.initialMarkdown 写入可读占位说明
 * - block.notes 挂一条 code: 'convert-failed' 的提示
 */
export function convertBlock(block: Block, options?: ConvertBlockOptions): Block {
  const turndown =
    options?.turndownService || createTurndown({ baseUrl: options?.baseUrl });

  let converted = '';
  let failed = false;

  try {
    const preparedHtml = prepareRichMediaPlaceholders(block.originalHtml);
    converted = turndown.turndown(preparedHtml);
    // ADR-0007: 块首尾空白由外层拼接统一负责，修整首尾空行
    converted = converted.trim();
  } catch {
    failed = true;
  }

  // 判定原始 HTML 是否非空（有文本或实质标签）
  const hasOriginalHtml = Boolean(block.originalHtml && block.originalHtml.trim().length > 0);

  // 单块级降级判定
  if (failed || (hasOriginalHtml && converted.length === 0)) {
    const notes: ConversionNote[] = [...block.notes];
    if (!notes.some((n) => n.code === 'convert-failed')) {
      notes.push({
        code: 'convert-failed',
        message: '该内容块无法转换，已降级保留原始 HTML 记录',
      });
    }

    return {
      ...block,
      type: 'unknown',
      initialMarkdown: '> 【未识别内容】该内容块无法转换为 Markdown，已降级保留原始 HTML 记录。',
      notes,
    };
  }

  // 富媒体卡片挂专用提示（docs/conversion-rules.md §4.10）
  const notes: ConversionNote[] = [...block.notes];
  if (
    block.type === 'richMedia' ||
    (block.originalHtml && block.originalHtml.includes('mp-common-'))
  ) {
    if (!notes.some((n) => n.code === 'richmedia-placeholder')) {
      notes.push({
        code: 'richmedia-placeholder',
        message: '富媒体卡片已转换为占位说明',
      });
    }
  }

  // 表格降级提示挂载（docs/conversion-rules.md §4.7 与 Issue #22）
  if (
    block.type === 'table' ||
    (block.originalHtml && block.originalHtml.includes('<table'))
  ) {
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(block.originalHtml, 'text/html');
        const tables = Array.from(doc.querySelectorAll('table'));
        if (tables.some(isTableDegraded)) {
          if (!notes.some((n) => n.code === 'table-degraded')) {
            notes.push({
              code: 'table-degraded',
              message: '表格包含合并单元格或复杂嵌套，已降级为可读文本',
            });
          }
        }
      } catch {
        // 忽略 DOMParser 容错
      }
    }
  }

  return {
    ...block,
    initialMarkdown: converted,
    notes,
  };
}

/**
 * 批量转换内容块（以块为独立单元）
 */
export function convertBlocks(blocks: Block[], options?: ConvertBlockOptions): Block[] {
  const turndown =
    options?.turndownService || createTurndown({ baseUrl: options?.baseUrl });
  return blocks.map((block) =>
    convertBlock(block, { ...options, turndownService: turndown })
  );
}

export interface BuildArticleSnapshotOptions {
  snapshotId?: string;
  capturedAt?: string;
}

/**
 * 组装完整的 ArticleSnapshot（对应 ARCHITECTURE.md §4.4、§5）
 *
 * 流程：
 * 1. splitBlocks 切出内容块
 * 2. convertBlocks 逐块独立转换出 initialMarkdown（带单块级降级）
 * 3. collectImages 收集全篇去重后的 ImageAsset[]
 * 4. 组装 ArticleSnapshot
 */
export function buildArticleSnapshot(
  capture: Extract<CaptureResult, { kind: 'article' }>,
  options?: BuildArticleSnapshotOptions
): ArticleSnapshot {
  const baseUrl = capture.source.url;

  // 1. 切块
  const rawBlocks = splitBlocks(capture.contentHtml);

  // 2. 逐块独立转换
  const blocks = convertBlocks(rawBlocks, { baseUrl });

  // 3. 收集并去重图片资源
  const images = collectImages(blocks, baseUrl);

  // 4. 组装 captureWarnings（如文章未完全加载）
  const captureWarnings: ConversionNote[] = [];
  if (capture.unstable) {
    captureWarnings.push({
      code: 'capture-unstable',
      message: '文章可能还没显示完整，可以回到原文等它加载完再重新抓一次',
    });
  }

  return {
    snapshotId: options?.snapshotId || crypto.randomUUID(),
    capturedAt: options?.capturedAt || new Date().toISOString(),
    source: capture.source,
    blocks,
    images,
    captureWarnings,
  };
}

export const turndownService = createTurndown();

/**
 * 验证 Turndown + GFM 表格转换功能正常（自检用）
 */
export function verifyTurndownTable(): string {
  const sampleHtml = '<table><tr><th>表头</th></tr><tr><td>单元格</td></tr></table>';
  return turndownService.turndown(sampleHtml);
}
