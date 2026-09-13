import type { Block, BlockType } from '../../shared/types';
import { mergeAdjacentLists } from './rules/list';
import { findFormulaContextContainer, hasOtherSignificantContent } from './rules/formula';

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// 排版容器标签：不识别为完整单元时穿透

const PASSTHROUGH = new Set([
  'section',
  'div',
  'article',
  'main',
  'figure',
  'center',
  'font',
  'fieldset',
]);

// 块级后代集合：存在这些后代意味着当前元素仍是容器，不是叶子内容
const BLOCKISH = new Set([
  ...PASSTHROUGH,
  ...HEADINGS,
  'p',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
  'li',
  'tr',
  'td',
  'th',
]);

// 富媒体标签与特征
const RICH_TAGS = new Set([
  'iframe',
  'video',
  'audio',
  'mpvoice',
  'mp-common-profile',
  'mp-common-miniprogram',
  'mp-miniprogram',
  'mp-common-videosnap',
  'mp-common-mpaudio',
  'qqmusic',
  'mpvideosnap',
  'mpprofile',
]);

const FORMULA_TAGS = new Set(['mjx-container', 'math', 'semantics', 'annotation']);

/**
 * 判定元素是否为公式载体。
 * 注意：根据 docs/conversion-rules.md §4.9 与验收标准，
 * 若公式是图片（LaTeX 截图，img 元素），走图片块的通用逻辑，不作为 formula 块处理。
 */
function isFormulaEl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return false; // 公式若是图片走图片块通用逻辑
  if (FORMULA_TAGS.has(tag)) return true;
  if (tag.startsWith('mjx-')) return true;

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  if (/(mathjax|MathJax|katex|wxformula|formula)/i.test(cls)) return true;

  return false;
}

/**
 * 判定公式是否独占一行（独立公式）。
 * 判据参考 docs/conversion-rules.md §4.9：「父级是否只有它一个有内容的孩子」。
 * 行内公式留在所属文字块里，不得切碎句子。
 * 容器定位（向上穿透行内包装标签）与兄弟内容扫描逻辑与 rules/formula.ts 的
 * isStandaloneFormulaNode 共用，避免两处各自维护一份相近但不同步的实现。
 */
function isBlockLevelFormula(el: Element): boolean {
  if (!el.parentElement) return true;
  if (el.parentElement && isFormulaEl(el.parentElement)) {
    return false;
  }
  const container = findFormulaContextContainer(el);
  return !hasOtherSignificantContent(container, el);
}

/**
 * 判定元素是否为富媒体卡片
 */
function isRichMedia(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (RICH_TAGS.has(tag)) return true;
  if (el.hasAttribute('data-miniprogram-appid')) return true;

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  return /^(video_iframe|js_video|mp-common-|mpprofile|js_uneditable|weapp_|qqmusic|res_iframe)/.test(cls);
}

/**
 * 噪声判据：script、style、无文本的 pre[class*="js_darkmode"]、.qr_code_pc、.reward_area
 */
export function isKnownNoise(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  if (tag === 'script' || tag === 'style') return true;

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  if (tag === 'pre' && /darkmode/i.test(cls) && !(el.textContent || '').trim()) {
    return true;
  }
  if (cls && /(qr_code_pc|reward_area)/.test(cls)) {
    return true;
  }
  return false;
}

/**
 * 是否为正文内容图片（排除公式 SVG）
 */
function isContentImg(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'img') return false;
  if (isFormulaEl(el)) return false;
  return Boolean(el.getAttribute('data-src') || el.getAttribute('src'));
}

/**
 * 是否有块级后代
 */
function hasBlockDescendant(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    const tag = c.tagName.toLowerCase();
    if (BLOCKISH.has(tag)) return true;
    if (hasBlockDescendant(c)) return true;
  }
  return false;
}

/**
 * 完整语义单元类型判定。
 * 完整语义单元优先于容器标签判断。
 */
function unitType(el: Element): BlockType | 'noise' | null {
  if (isKnownNoise(el)) return 'noise';
  if (isRichMedia(el)) return 'richMedia';
  if (isFormulaEl(el)) {
    return isBlockLevelFormula(el) ? 'formula' : null;
  }

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  // 行号容器不是内容列表（docs/conversion-rules.md §4.5），直接排噪
  if (cls.includes('code-snippet__line-index')) {
    return 'noise';
  }

  const tag = el.tagName.toLowerCase();
  if (HEADINGS.has(tag)) return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'table') return 'table';
  if (tag === 'hr') return 'divider';

  if (tag === 'pre' || /code-snippet|code_snippet|hljs|prettyprint/.test(cls)) {
    return 'code';
  }

  // 独立的未知对象/嵌入卡片（如 canvas, embed, object, applet）
  // 供用户决定保留或剔除（docs/conversion-rules.md §4.11）
  if (tag === 'canvas' || tag === 'embed' || tag === 'object' || tag === 'applet') {
    return 'unknown';
  }

  return null;
}

/**
 * 穿透判据配套：「无块级后代」不足以判定叶子，
 * 有完整语义单元后代（如公众号名片 mp-common-profile）时必须继续穿透。
 */
function hasUnitDescendant(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    if (unitType(c)) return true;
    if (hasUnitDescendant(c)) return true;
  }
  return false;
}

interface RawBlockEmission {
  type: BlockType;
  originalHtml: string;
  headingLevel?: number;
}

/**
 * 将叶子内容元素按「文字 A → 图片 → 文字 B」拆块。
 * 仅包裹图片的段落成图片块；纯空白或空节点不产生块。
 */
function splitLeafByImages(el: Element): RawBlockEmission[] {
  const allImgs = Array.from(el.querySelectorAll('img')).filter(isContentImg);

  // 无图片：若有实质文字则整块成段落，无文字无图片则不产生块
  if (allImgs.length === 0) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) return [];
    return [{ type: 'paragraph', originalHtml: el.outerHTML }];
  }

  // 检查除图片外是否还有文字
  const textClone = el.cloneNode(true) as Element;
  for (const img of Array.from(textClone.querySelectorAll('img'))) {
    if (isContentImg(img)) {
      img.remove();
    }
  }
  const remainingText = (textClone.textContent || '').replace(/\s+/g, ' ').trim();
  if (remainingText.length === 0) {
    // 仅包裹图片的段落：每个内容图片各自成图片块
    return allImgs.map((img) => ({
      type: 'image',
      originalHtml: img.outerHTML,
    }));
  }

  // 文字与图片混排：按文档顺序切分
  const result: RawBlockEmission[] = [];
  let currentSegmentNodes: Node[] = [];

  const flushTextSegment = () => {
    if (currentSegmentNodes.length === 0) return;
    const segContainer = el.cloneNode(false) as Element;
    for (const n of currentSegmentNodes) {
      segContainer.appendChild(n.cloneNode(true));
    }
    const segText = (segContainer.textContent || '').replace(/\s+/g, ' ').trim();
    if (segText.length > 0) {
      result.push({ type: 'paragraph', originalHtml: segContainer.outerHTML });
    }
    currentSegmentNodes = [];
  };

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && isContentImg(child as Element)) {
        flushTextSegment();
        result.push({
          type: 'image',
          originalHtml: (child as Element).outerHTML,
        });
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).querySelector('img')) {
        const innerImgs = Array.from((child as Element).querySelectorAll('img')).filter(isContentImg);
        if (innerImgs.length > 0) {
          walk(child);
        } else {
          currentSegmentNodes.push(child);
        }
      } else {
        currentSegmentNodes.push(child);
      }
    }
  };

  walk(el);
  flushTextSegment();
  return result;
}

/**
 * 切块核心函数：把正文 DOM 切成内容块 Block[]
 * 依据 ARCHITECTURE.md §4.4、§5、§6.2，ADR-0001 与 docs/conversion-rules.md
 */
export function splitBlocks(input: string | Document | Element): Block[] {
  let root: Element;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('splitBlocks: Empty HTML input');
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, 'text/html');

    // 若输入为整页 HTML（含有 html 标签或 DOCTYPE），必须能定位到 #js_content
    const isFullPage = trimmed.includes('<html') || trimmed.includes('<!DOCTYPE');
    const jsContent = doc.querySelector('#js_content');
    if (isFullPage && !jsContent) {
      throw new Error('splitBlocks: Cannot find #js_content in full page HTML');
    }

    const candidate = jsContent || doc.body;
    if (!candidate) {
      throw new Error('splitBlocks: Failed to find content root');
    }
    root = candidate;
  } else if (input instanceof Document) {
    const jsContent = input.querySelector('#js_content');
    const candidate = jsContent || input.body;
    if (!candidate) {
      throw new Error('splitBlocks: Failed to find content root in Document');
    }
    root = candidate.cloneNode(true) as Element;
  } else if (input instanceof Element) {
    const jsContent = input.id === 'js_content' ? input : input.querySelector('#js_content');
    if (jsContent) {
      root = jsContent.cloneNode(true) as Element;
    } else {
      const wrapper = input.ownerDocument.createElement('div');
      wrapper.appendChild(input.cloneNode(true));
      root = wrapper;
    }
  } else {
    throw new Error('splitBlocks: Invalid input type');
  }

  // 假设 B（平铺兄弟 + list-paddingleft-N）：在切块前合并相邻兄弟列表为嵌套树（docs/conversion-rules.md §4.5）
  mergeAdjacentLists(root);

  const rawBlocks: RawBlockEmission[] = [];

  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      // 穿透容器时保留直接文本节点
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) {
          rawBlocks.push({
            type: 'paragraph',
            originalHtml: `<p>${t}</p>`,
          });
        }
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      // 完整语义单元优先于容器标签判断
      const u = unitType(el);
      if (u === 'noise') continue;
      if (u) {
        const emission: RawBlockEmission = {
          type: u,
          originalHtml: el.outerHTML,
        };
        if (u === 'heading') {
          const levelMatch = tag.match(/^h([1-6])$/);
          if (levelMatch) {
            emission.headingLevel = parseInt(levelMatch[1], 10);
          }
        }
        rawBlocks.push(emission);
        continue;
      }

      // 单独的图片元素
      if (isContentImg(el)) {
        rawBlocks.push({
          type: 'image',
          originalHtml: el.outerHTML,
        });
        continue;
      }

      // 常见空节点或无内容标签跳过
      if (tag === 'br' || tag === 'script' || tag === 'style') continue;

      // 穿透判据：「有块级后代 OR 有完整语义单元后代 就继续穿透」
      if (hasBlockDescendant(el) || hasUnitDescendant(el)) {
        visit(el);
        continue;
      }

      // 叶子内容元素：按「文字 A → 图片 → 文字 B」拆块
      const parts = splitLeafByImages(el);
      for (const p of parts) {
        rawBlocks.push(p);
      }
    }
  };

  visit(root);

  // 生成符合 ARCHITECTURE.md §5 规范的 Block[]
  return rawBlocks.map((raw, index) => {
    const block: Block = {
      id: crypto.randomUUID(),
      order: index + 1,
      type: raw.type,
      originalHtml: raw.originalHtml,
      initialMarkdown: '',
      editedMarkdown: null,
      included: true,
      notes: [],
    };
    if (raw.headingLevel !== undefined) {
      block.headingLevel = raw.headingLevel;
    }
    return block;
  });
}
