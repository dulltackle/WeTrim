import type TurndownService from 'turndown';

/**
 * 依据 docs/conversion-rules.md §4.9 与 ARCHITECTURE.md §6.1、§10.3：
 * 公式规则支持 MathJax 2/3、KaTeX、MathML 等公式载体。
 *
 * 方言约定：
 * - 行内公式：$…$
 * - 独立公式：$$…$$
 * - 若提取不到 TeX 内容：使用类别可读占位 $【公式】$ 或 $$【公式】$$，不静默丢失。
 * - 证据标记：⚠️ 无真实公式样例，按推断实现并在文档与自检中保留标注。
 */

const FORMULA_TAG_NAMES = new Set(['mjx-container', 'math', 'semantics', 'annotation']);

/**
 * 判定节点是否为公式载体
 */
export function isFormulaElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return false; // LaTeX 截图走通用图片逻辑，不在此拦截
  if (FORMULA_TAG_NAMES.has(tag)) return true;
  if (tag.startsWith('mjx-')) return true;

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  if (/(mathjax|MathJax|katex|wxformula|formula)/i.test(cls)) return true;

  if (
    el.hasAttribute('data-tex') ||
    el.hasAttribute('data-formula') ||
    el.hasAttribute('data-latex')
  ) {
    return true;
  }

  return false;
}

/**
 * 从各类公式载体中提取 TeX / LaTeX 源码
 */
export function extractFormulaTex(el: Element): string {
  // 1. 常见属性提取（含 aria-label 增强兼容性）
  const rawAttr =
    el.getAttribute('data-tex') ||
    el.getAttribute('data-formula') ||
    el.getAttribute('data-latex') ||
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    '';

  let tex = rawAttr.trim();

  // 2. MathML / KaTeX / MathJax 子节点提取（annotation / script / title）
  if (!tex) {
    const annot =
      el.querySelector('annotation[encoding*="tex"]') ||
      el.querySelector('annotation[encoding*="latex"]') ||
      el.querySelector('annotation') ||
      el.querySelector('script[type*="math/tex"]');
    if (annot && annot.textContent) {
      tex = annot.textContent.trim();
    }
  }

  // 3. SVG 标题提取
  if (!tex) {
    const svgTitle = el.querySelector('svg title');
    if (svgTitle && svgTitle.textContent) {
      tex = svgTitle.textContent.trim();
    }
  }

  // 4. title 属性或 textContent 回退
  if (!tex) {
    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.trim()) {
      tex = titleAttr.trim();
    } else {
      // 避免取到 MathML 或 KaTeX 内部冗长无意义的 HTML 渲染文本
      if (!el.querySelector('mrow, span.katex-html, span.mjx-chtml')) {
        const txt = (el.textContent || '').trim();
        if (txt && !txt.includes('\n')) {
          tex = txt;
        }
      }
    }
  }

  // 规范化修整：去除首尾可能自带的 $ 或 $$ 包裹
  if (tex.startsWith('$$') && tex.endsWith('$$') && tex.length >= 4) {
    tex = tex.slice(2, -2).trim();
  } else if (tex.startsWith('$') && tex.endsWith('$') && tex.length >= 2) {
    tex = tex.slice(1, -1).trim();
  }

  return tex;
}

/**
 * 「透明行内包装标签」集合：公式向上寻找块级容器、判定独立/行内时穿透这些标签。
 * split-blocks.ts 的 isBlockLevelFormula 与本文件的 isStandaloneFormulaNode 共用同一份定义与扫描逻辑，
 * 避免两处各自维护一份相近但不同步的标签表与遍历实现。
 */
export const FORMULA_CONTEXT_INLINE_TAGS = new Set([
  'span',
  'font',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'strike',
  'small',
  'sub',
  'sup',
  'a',
  'label',
  'mark',
  'br',
  'wbr',
]);

/**
 * 向上穿透透明行内包装元素（如 span），定位至公式所在的最贴近块级容器。
 */
export function findFormulaContextContainer(el: Element): Element {
  let container: Element = el.parentElement ?? el;
  while (
    container.parentElement &&
    FORMULA_CONTEXT_INLINE_TAGS.has(container.tagName.toLowerCase())
  ) {
    container = container.parentElement;
  }
  return container;
}

/**
 * 判定容器内除目标节点（及包含目标节点的祖先分支）外，是否还有实质文本或图片内容。
 */
export function hasOtherSignificantContent(container: Element, target: Element): boolean {
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || '').replace(/\s+/g, ' ').trim().length > 0) {
        return true;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child as Element;
      if (c === target || c.contains(target)) continue;
      if (c.tagName.toLowerCase() === 'br') continue;
      if ((c.textContent || '').trim().length > 0 || c.querySelector('img')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 判定公式在当前 DOM 上下文中是否为独立块级公式。
 * 向上穿透透明行内包装元素（如 span），定位至实际块级容器判断兄弟内容。
 */
function isStandaloneFormulaNode(el: HTMLElement): boolean {
  // 显式声明为 display
  const displayAttr = el.getAttribute('display');
  if (displayAttr === 'true' || displayAttr === 'block') return true;

  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  if (/katex-display|math-display/i.test(cls)) return true;

  if (!el.parentElement) return true;

  const container = findFormulaContextContainer(el);
  const containerTag = container.tagName.toLowerCase();
  if (containerTag === 'body' || containerTag === 'html') return true;

  return !hasOtherSignificantContent(container, el);
}

/**
 * 注册微信公式 Turndown 规则
 */
export function registerFormulaRules(turndown: TurndownService): void {
  turndown.addRule('wechatFormula', {
    filter: (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const el = node as HTMLElement;
      if (el.classList.contains('wechat-formula')) return true;
      if (el.parentElement && isFormulaElement(el.parentElement)) {
        return false;
      }
      return isFormulaElement(el);
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const tex =
        el.getAttribute('data-formula-tex') !== null
          ? el.getAttribute('data-formula-tex') || ''
          : extractFormulaTex(el);

      const isStandalone =
        el.getAttribute('data-standalone') === 'true' ||
        isStandaloneFormulaNode(el);

      if (!tex) {
        // 无 TeX 源码时输出可读占位说明，不伪造信息、不用空字符串掩盖丢失
        return isStandalone ? '\n\n$$【公式】$$\n\n' : '$【公式】$';
      }

      if (isStandalone) {
        return `\n\n$$${tex}$$\n\n`;
      }
      return `$${tex}$`;
    },
  });
}

/**
 * 将公式载体元素预转换为带有标记与实质占位文本的节点。
 * 解决两项关键问题：
 * 1. 解决 Turndown 对无文本子节点的自定义标签（如 mjx-container）判定为 isBlank 而提前静默丢弃的问题；
 * 2. 避免直接以普通文本替换导致 LaTeX 语法字符（如 \int_0 中的 _ 与 \）被 Turndown 的 text escaper 误转义。
 */
export function prepareFormulaPlaceholders(html: string): string {
  // 注意：不要用裸露的 'tex' 子串做快速路径判断——英文单词 "text" 本身就包含
  // 该子串，几乎每个正文块都会命中，导致这个早退分支形同虚设。改用更贴近实际
  // 探测目标（标签名/类名/专用属性）的子串，并统一转小写比较避免大小写遗漏。
  const lower = html.toLowerCase();
  const mightBeFormula =
    lower.includes('mjx-') ||
    lower.includes('<math') ||
    lower.includes('semantics') ||
    lower.includes('annotation') ||
    lower.includes('katex') ||
    lower.includes('mathjax') ||
    lower.includes('formula') ||
    lower.includes('data-tex') ||
    lower.includes('data-latex') ||
    lower.includes('x-tex');

  if (!mightBeFormula) {
    return html;
  }

  if (typeof DOMParser === 'undefined') return html;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 查找所有顶层公式元素（避免重复匹配内部子节点）
    const allFormulas = Array.from(doc.querySelectorAll('*')).filter((el) => {
      if (!isFormulaElement(el)) return false;
      // 若祖先已是公式元素，则不重复处理
      let parent = el.parentElement;
      while (parent) {
        if (isFormulaElement(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });

    if (allFormulas.length === 0) return html;

    for (const el of allFormulas) {
      const tex = extractFormulaTex(el);
      const isStandalone = isStandaloneFormulaNode(el as HTMLElement);

      const span = doc.createElement('span');
      span.className = 'wechat-formula';
      span.setAttribute('data-formula-tex', tex);
      span.setAttribute('data-standalone', isStandalone ? 'true' : 'false');
      // 填入非空占位，保证 Turndown isBlank 检查通过并命中 wechatFormula 规则
      span.textContent = 'MATH_FORMULA';
      el.replaceWith(span);
    }

    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
