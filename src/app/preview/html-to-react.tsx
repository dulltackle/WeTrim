import React from 'react';
import { ImagePresentation } from '../components/ImagePresentation';

// Preflight 不提供列表标记；正文和预览共用此排版，保留输入中的内联样式优先级。
const ARTICLE_CONTENT_CLASS = 'block-rendered-content text-ink-primary text-[15px] leading-[1.75] break-words [overflow-wrap:break-word] min-w-0 cursor-text [overflow-anchor:auto] [&_a]:cursor-text [&_pre]:cursor-text [&_code]:cursor-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0';

// 在正文父容器上应用一次后代排版，避免每个内容块重复数百个工具类 token。
export const ARTICLE_TYPOGRAPHY_CLASSES = [
  '[&_.block-rendered-content_p]:my-1.5 [&_.block-rendered-content_h1]:text-[22px] [&_.block-rendered-content_h1]:font-bold [&_.block-rendered-content_h1]:leading-[1.4] [&_.block-rendered-content_h1]:mt-2.5 [&_.block-rendered-content_h1]:mb-1.5 [&_.block-rendered-content_h2]:text-[19px] [&_.block-rendered-content_h2]:font-semibold [&_.block-rendered-content_h2]:leading-[1.4] [&_.block-rendered-content_h2]:mt-2 [&_.block-rendered-content_h2]:mb-1.5',
  '[&_.block-rendered-content_h3]:text-[17px] [&_.block-rendered-content_h3]:font-semibold [&_.block-rendered-content_h3]:leading-[1.4] [&_.block-rendered-content_h3]:mt-2 [&_.block-rendered-content_h3]:mb-1 [&_.block-rendered-content_:is(h4,h5,h6)]:text-[15px] [&_.block-rendered-content_:is(h4,h5,h6)]:font-semibold [&_.block-rendered-content_:is(h4,h5,h6)]:leading-[1.4] [&_.block-rendered-content_:is(h4,h5,h6)]:mt-1.5 [&_.block-rendered-content_:is(h4,h5,h6)]:mb-1',
  '[&_.block-rendered-content_ul]:list-disc [&_.block-rendered-content_ol]:list-decimal [&_.block-rendered-content_:is(ul,ol)]:pl-6 [&_.block-rendered-content_:is(ul,ol)]:my-1.5 [&_.block-rendered-content_li]:mb-1 [&_.block-rendered-content_blockquote]:border-l-[3px] [&_.block-rendered-content_blockquote]:border-sheet-border [&_.block-rendered-content_blockquote]:py-2 [&_.block-rendered-content_blockquote]:px-4 [&_.block-rendered-content_blockquote]:bg-sheet-bg-alt [&_.block-rendered-content_blockquote]:text-ink-secondary [&_.block-rendered-content_blockquote]:my-2 [&_.block-rendered-content_blockquote]:rounded-[2px]',
  '[&_.block-rendered-content_table]:w-full [&_.block-rendered-content_table]:border-collapse [&_.block-rendered-content_table]:text-[13px] [&_.block-rendered-content_table]:leading-[1.5] [&_.block-rendered-content_table]:my-2 [&_.block-rendered-content_table]:overflow-x-auto [&_.block-rendered-content_table]:block [&_.block-rendered-content_:is(th,td)]:border [&_.block-rendered-content_:is(th,td)]:border-sheet-border [&_.block-rendered-content_:is(th,td)]:py-1.5 [&_.block-rendered-content_:is(th,td)]:px-2.5 [&_.block-rendered-content_:is(th,td)]:text-left [&_.block-rendered-content_th]:bg-surface-muted [&_.block-rendered-content_th]:font-semibold',
  '[&_.block-rendered-content_pre]:bg-surface-muted [&_.block-rendered-content_pre]:border [&_.block-rendered-content_pre]:border-sheet-border [&_.block-rendered-content_pre]:py-2.5 [&_.block-rendered-content_pre]:px-3.5 [&_.block-rendered-content_pre]:rounded-[2px] [&_.block-rendered-content_pre]:overflow-x-auto [&_.block-rendered-content_pre]:font-mono [&_.block-rendered-content_pre]:text-[13px] [&_.block-rendered-content_pre]:leading-[1.5] [&_.block-rendered-content_pre]:my-2 [&_.block-rendered-content_code]:font-mono [&_.block-rendered-content_code]:text-[13px] [&_.block-rendered-content_code]:bg-black/[0.04] [&_.block-rendered-content_code]:py-px [&_.block-rendered-content_code]:px-1 [&_.block-rendered-content_code]:rounded-[2px] [&_.block-rendered-content_pre_code]:bg-transparent [&_.block-rendered-content_pre_code]:p-0',
  '[&_.block-rendered-content_hr]:border-0 [&_.block-rendered-content_hr]:border-t [&_.block-rendered-content_hr]:border-sheet-border [&_.block-rendered-content_hr]:my-3 [&_.block-rendered-content_:where(img)]:max-w-full [&_.block-rendered-content_:where(img)]:h-auto [&_.block-rendered-content_:where(img)]:rounded-[2px] [&_.block-rendered-content_:where(img)]:block [&_.block-rendered-content_:where(img)]:my-1.5',
].join(' ');

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
 * 不含图片的块快速走 dangerouslySetInnerHTML 保证极致性能。
 */
export function renderHtmlWithImages(html: string): React.ReactNode {
  if (!html) return null;

  // 不含图片的普通文本块：直接走原生 innerHTML 快速路径
  if (!html.includes('<img')) {
    return (
      <div
        className={ARTICLE_CONTENT_CLASS}
        data-testid="block-rendered-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

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
  return renderChildNodesWithImages(doc.body);
}

/**
 * 整篇预览用：直接消费 renderMarkdownToFragment 的净化结果，不再重复解析 HTML。
 */
export function renderFragmentWithImages(fragment: DocumentFragment): React.ReactNode {
  if (!fragment.firstChild) return null;
  if (!fragment.querySelector('img')) {
    const container = (fragment.ownerDocument ?? document).createElement('div');
    container.appendChild(fragment);
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
