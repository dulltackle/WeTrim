import React from 'react';
import { ImagePresentation } from '../components/ImagePresentation';

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
    // 将 kebab-case (如 text-align) 转换为 camelCase (如 textAlign)
    const camelProp = rawProp.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    styleObj[camelProp] = rawVal;
  }
  return styleObj;
}

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
      return <ImagePresentation key={key} src={src} alt={alt} title={title} />;
    }

    const children: React.ReactNode[] = [];
    for (let i = 0; i < el.childNodes.length; i++) {
      const childNode = domNodeToReact(el.childNodes[i], `${key}-${i}`);
      if (childNode !== null && childNode !== undefined) {
        children.push(childNode);
      }
    }

    const props: Record<string, any> = { key };
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      let name = attr.name;
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
        className="block-rendered-content"
        data-testid="block-rendered-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (typeof DOMParser === 'undefined') {
    return (
      <div
        className="block-rendered-content"
        data-testid="block-rendered-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < doc.body.childNodes.length; i++) {
    const rNode = domNodeToReact(doc.body.childNodes[i], `r-${i}`);
    if (rNode !== null && rNode !== undefined) {
      nodes.push(rNode);
    }
  }

  return (
    <div className="block-rendered-content" data-testid="block-rendered-content">
      {nodes}
    </div>
  );
}
