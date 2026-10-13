import React from 'react';
import { ImagePresentation } from '../components/ImagePresentation';

// 排版直接附到净化后的呈现节点，避免全文后代选择器扫描；这些类不会进入 Markdown 或保存正文。
const ARTICLE_CONTENT_CLASS = 'block-rendered-content text-ink-primary text-[15px] leading-[1.75] break-words [overflow-wrap:break-word] min-w-0 cursor-text [overflow-anchor:auto] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-[2px] [&_img]:block [&_img]:my-1.5';

const ARTICLE_TAG_CLASSES: Record<string, string> = {
  p: 'my-1.5',
  h1: 'text-[22px] font-bold leading-[1.4] mt-2.5 mb-1.5',
  h2: 'text-[19px] font-semibold leading-[1.4] mt-2 mb-1.5',
  h3: 'text-[17px] font-semibold leading-[1.4] mt-2 mb-1',
  h4: 'text-[15px] font-semibold leading-[1.4] mt-1.5 mb-1',
  h5: 'text-[15px] font-semibold leading-[1.4] mt-1.5 mb-1',
  h6: 'text-[15px] font-semibold leading-[1.4] mt-1.5 mb-1',
  ul: 'list-disc pl-6 my-1.5',
  ol: 'list-decimal pl-6 my-1.5',
  li: 'mb-1',
  blockquote: 'border-l-[3px] border-sheet-border py-2 px-4 bg-sheet-bg-alt text-ink-secondary my-2 rounded-[2px]',
  table: 'w-full border-collapse text-[13px] leading-[1.5] my-2 overflow-x-auto block',
  th: 'border border-sheet-border py-1.5 px-2.5 text-left bg-surface-muted font-semibold',
  td: 'border border-sheet-border py-1.5 px-2.5 text-left',
  pre: 'bg-surface-muted border border-sheet-border py-2.5 px-3.5 rounded-[2px] overflow-x-auto font-mono text-[13px] leading-[1.5] my-2 cursor-text',
  code: 'font-mono text-[13px] bg-black/[0.04] py-px px-1 rounded-[2px] cursor-text',
  hr: 'border-0 border-t border-sheet-border my-3',
  a: 'cursor-text',
};
const ARTICLE_TAG_SELECTOR = Object.keys(ARTICLE_TAG_CLASSES).join(',');

function decorateArticleMarkup(root: HTMLElement | DocumentFragment): void {
  for (const el of root.querySelectorAll(ARTICLE_TAG_SELECTOR)) {
    const tag = el.tagName.toLowerCase();
    const classes = tag === 'code' && el.closest('pre')
      ? 'font-mono text-[13px] bg-transparent p-0 rounded-[2px] cursor-text'
      : ARTICLE_TAG_CLASSES[tag];
    el.setAttribute('class', [el.getAttribute('class'), classes].filter(Boolean).join(' '));
  }
}

/**
 * 将内联 style 字符串解析为 React.CSSProperties 对象，
 * 避免 React 抛出 'The style prop expects a mapping from style properties to values, not a string' 异常。
 */
function parseStyleString(styleStr: string): React.CSSProperties {
  const styleObj: Record<string, string> = {};
  if (!styleStr) return styleObj;
  const declarations = styleStr.split(';');
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const rawProp = decl.slice(0, colonIdx).trim();
    const rawVal = decl.slice(colonIdx + 1).trim();
    if (!rawProp || !rawVal) continue;
    // CSS 自定义属性（--x）React 原样接受；其余 kebab-case (如 text-align) 转换为 camelCase (如 textAlign)
    const prop = rawProp.startsWith('--')
      ? rawProp
      : rawProp.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    styleObj[prop] = rawVal;
  }
  return styleObj;
}

/**
 * HTML 布尔属性：DOM 上的值是空串（如 GFM 任务列表的 `<input checked="" disabled="">`），
 * 原样交给 React 会被当成 false，必须转成 true。
 * checked / value 用非受控写法，只读展示不需要 onChange。
 */
const BOOLEAN_ATTR_PROPS: Record<string, string> = {
  checked: 'defaultChecked',
  disabled: 'disabled',
  readonly: 'readOnly',
  hidden: 'hidden',
  open: 'open',
  reversed: 'reversed',
  multiple: 'multiple',
};

/**
 * 将 DOMParser 解析得到的节点转换为 React 元素。
 * 当遇到 <img> 标签时，替换为清洗页专用的 ImagePresentation 组件，
 * 实现缩略图限高、长图标记与展开、原位失败占位与重试、看原图浮层。
 */
function domNodeToReact(node: Node, key: string): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    const tagName = el.tagName.toLowerCase();

    if (tagName === 'img') {
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      const title = el.getAttribute('title') || undefined;
      // key 带上 src：地址变化时整体重挂载，加载状态与长图判定随之重置
      return <ImagePresentation key={`${key}-${src}`} src={src} alt={alt} title={title} />;
    }

    const props: Record<string, unknown> = { key };
    if (el.attributes.length > 0) {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        let name = attr.name;
        // React 不接受 option 上的 selected（应由 select 的 defaultValue 决定），只读展示直接忽略
        if (name === 'selected') continue;
        if (name in BOOLEAN_ATTR_PROPS) {
          props[BOOLEAN_ATTR_PROPS[name]] = true;
          continue;
        }
        if (name === 'value' && tagName === 'input') {
          props.defaultValue = attr.value;
          continue;
        }
        if (name === 'class') name = 'className';
        else if (name === 'for') name = 'htmlFor';
        else if (name === 'colspan') name = 'colSpan';
        else if (name === 'rowspan') name = 'rowSpan';
        else if (name === 'style') {
          props.style = parseStyleString(attr.value);
          continue;
        } else if (name.startsWith('on')) {
          continue;
        }
        props[name] = attr.value;
      }
    }

    const VOID_ELEMENTS = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);
    if (VOID_ELEMENTS.has(tagName)) {
      return React.createElement(tagName, props);
    }

    // 性能优化：若当前元素内部不包含 <img> 标签，直接使用 dangerouslySetInnerHTML 快速注入子节点，
    // 避免对大规模纯文本段落（如 600 块长文）深层递归遍历全部 TextNode 与行内元素
    const innerHtml = el.innerHTML;
    if (!innerHtml) {
      return React.createElement(tagName, props);
    }
    if (!innerHtml.includes('<img')) {
      props.dangerouslySetInnerHTML = { __html: innerHtml };
      return React.createElement(tagName, props);
    }

    const children: React.ReactNode[] = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      const childNode = domNodeToReact(el.childNodes[i], `${key}-${i}`);
      if (childNode !== null && childNode !== undefined) {
        children.push(childNode);
      }
    }

    return React.createElement(tagName, props, ...children);
  }

  return null;
}

/**
 * 依据 Issue #30：
 * 清洗页专用的渲染层。保持 renderMarkdown 方言输出不变的前提下，
 * 将含图片的 HTML 转换为带 ImagePresentation 呈现层的 React 虚拟 DOM。
 * 新调用优先直接传净化片段，避免 HTML 序列化与重复解析。
 */
export function renderHtmlWithImages(html: string): React.ReactNode {
  if (!html) return null;

  if (typeof DOMParser === 'undefined') {
    return (
      <div
        className={ARTICLE_CONTENT_CLASS}
        data-testid="block-rendered-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  decorateArticleMarkup(doc.body);
  return renderChildNodesWithImages(doc.body);
}

/**
 * 正文和预览共用：直接消费 renderMarkdownToFragment 的净化结果，不再重复解析 HTML。
 * chunked=false 用于单个内容块；预览保留不含图分片，交由浏览器缓存绘制。
 */
export function renderFragmentWithImages(fragment: DocumentFragment, chunked = true): React.ReactNode {
  if (!fragment.firstChild) return null;
  decorateArticleMarkup(fragment);
  if (!fragment.querySelector('img')) {
    const container = (fragment.ownerDocument ?? document).createElement('div');
    container.appendChild(fragment);
    if (!chunked) return <div className={ARTICLE_CONTENT_CLASS} data-testid="block-rendered-content" dangerouslySetInnerHTML={{ __html: container.innerHTML }} />;
    return (
      <div className={ARTICLE_CONTENT_CLASS} data-testid="block-rendered-content">
        <div
          key="chunk-0"
          className="block-rendered-chunk [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          dangerouslySetInnerHTML={{ __html: container.innerHTML }}
        />
      </div>
    );
  }
  return renderChildNodesWithImages(fragment);
}

/**
 * 把 root 的直接子节点按「含图 / 不含图」分段：连续的不含图节点合并成一个 innerHTML 分片，
 * 含图节点转成带 ImagePresentation 的 React 树。
 * 针对长文性能优化：通过原位节点迁移（appendChild）避免沉重的 Range / cloneContents 计算。
 */
function renderChildNodesWithImages(root: HTMLElement | DocumentFragment): React.ReactNode {
  const doc = root.ownerDocument ?? document;
  // 一次查出全部图片再上溯到 root 的直接子节点，避免对几百个子节点各做一次 querySelector
  const imgHosts = new Set<Node>();
  root.querySelectorAll('img').forEach((img) => {
    let host: Node = img;
    while (host.parentNode && host.parentNode !== root) host = host.parentNode;
    imgHosts.add(host);
  });

  const nodes: React.ReactNode[] = [];
  const children = Array.from(root.childNodes);
  let chunkContainer: HTMLDivElement | null = null;
  let chunkIndex = 0;

  const flushChunk = () => {
    if (chunkContainer && chunkContainer.hasChildNodes()) {
      const html = chunkContainer.innerHTML;
      if (html) {
        nodes.push(
          <div
            key={`chunk-${chunkIndex++}`}
            className="block-rendered-chunk"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }
      chunkContainer = null;
    }
  };

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (imgHosts.has(child)) {
      flushChunk();
      const rNode = domNodeToReact(child, `r-${i}`);
      if (rNode !== null && rNode !== undefined) {
        nodes.push(rNode);
      }
    } else {
      if (!chunkContainer) {
        chunkContainer = doc.createElement('div');
      }
      chunkContainer.appendChild(child);
    }
  }
  flushChunk();

  return (
    <div className={ARTICLE_CONTENT_CLASS} data-testid="block-rendered-content">
      {nodes.map((node, index) => {
        if (!React.isValidElement<{ className?: string }>(node) || node.props.className !== 'block-rendered-chunk') return node;
        // 首尾分片显式标记，避免双层结构伪类在插入 Portal 时使整个文章子树失效。
        return React.cloneElement(node, { className: 'block-rendered-chunk' +
          (index === 0 ? ' [&>*:first-child]:mt-0' : '') +
          (index === nodes.length - 1 ? ' [&>*:last-child]:mb-0' : '') });
      })}
    </div>
  );
}
