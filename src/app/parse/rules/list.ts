import type TurndownService from 'turndown';
import { isKnownNoise } from '../split-blocks';

/**
 * 判定是否为正文内容列表（排除代码块的行号 <ul> 等排噪元素）
 * 依据 docs/conversion-rules.md §4.5
 */
export function isContentList(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'ul' && tag !== 'ol') return false;
  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  if (cls.includes('code-snippet__line-index')) return false;
  return true;
}

/**
 * 从 class (如 list-paddingleft-2) 中解析层级缩进深度，默认 1
 */
export function getListLevel(el: Element): number {
  const cls = (typeof el.className === 'string' ? el.className : '') || '';
  const match = cls.match(/list-paddingleft-(\d+)/);
  if (match) {
    const lvl = parseInt(match[1], 10);
    return isNaN(lvl) || lvl < 1 ? 1 : lvl;
  }
  return 1;
}

/**
 * 获取列表内部最后一个直接 <li> 子元素
 */
function getLastDirectLi(list: Element): Element | null {
  const children = Array.from(list.children);
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].tagName.toLowerCase() === 'li') {
      return children[i];
    }
  }
  return null;
}

/**
 * 合并一组连续平铺的兄弟内容列表（假设 B：平铺兄弟 + list-paddingleft-N）
 *
 * 合并策略（依据 docs/conversion-rules.md §4.5 与 ADR-0001）：
 * 1. 首个列表作为合并根容器
 * 2. 维护层级栈 [{ level, el }]
 * 3. 遇到更深层级的列表，挂载到栈顶列表最后一个 <li> 内（转为真嵌套）
 * 4. 遇到相同或更浅层级的列表，退栈并合并 <li> 项
 *
 * 固有降级说明：
 * 作者连写两个独立一级列表（同标签名且中间不隔任何内容）时，平铺编码下与「一个列表」在 DOM 里无法区分，
 * 合并策略会统一将其并为一个列表块。
 */
function mergeListGroup(group: Element[]): void {
  const rootList = group[0];
  const rootLevel = getListLevel(rootList);
  const stack: { level: number; el: Element }[] = [{ level: rootLevel, el: rootList }];

  for (let i = 1; i < group.length; i++) {
    const list = group[i];
    const level = getListLevel(list);

    if (level > stack[stack.length - 1].level) {
      const parentList = stack[stack.length - 1].el;
      let targetLi = getLastDirectLi(parentList);
      if (!targetLi) {
        targetLi = parentList.ownerDocument.createElement('li');
        parentList.appendChild(targetLi);
      }
      targetLi.appendChild(list);
      stack.push({ level, el: list });
    } else {
      while (stack.length > 1 && stack[stack.length - 1].level > level) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top.level === level) {
        if (list.tagName === top.el.tagName) {
          while (list.firstChild) {
            top.el.appendChild(list.firstChild);
          }
          list.remove();
        } else {
          if (stack.length > 1) {
            top.el.parentElement?.appendChild(list);
            stack.pop();
            stack.push({ level, el: list });
          } else {
            // 根级不同标签名不强行同化
            break;
          }
        }
      } else if (level > top.level) {
        let targetLi = getLastDirectLi(top.el);
        if (!targetLi) {
          targetLi = top.el.ownerDocument.createElement('li');
          top.el.appendChild(targetLi);
        }
        targetLi.appendChild(list);
        stack.push({ level, el: list });
      }
    }
  }
}

/**
 * 在切块前合并相邻兄弟列表（假设 B：平铺兄弟 + list-paddingleft-N）
 * 遍历容器及其子容器，将中间无其它内容的相邻兄弟内容列表合并为嵌套树形结构
 */
export function mergeAdjacentLists(container: Element): void {
  // 仅收集直接含有 ul/ol 子元素的父级容器，避免全量 DOM 深度扫描开销
  const containers = new Set<Element>();
  if (container.querySelector('ul, ol')) {
    containers.add(container);
  }
  const lists = Array.from(container.querySelectorAll('ul, ol'));
  for (const l of lists) {
    if (l.parentElement) {
      containers.add(l.parentElement);
    }
  }

  for (const c of containers) {
    let child = c.firstElementChild;
    while (child) {
      if (!isContentList(child)) {
        child = child.nextElementSibling;
        continue;
      }

      const group: Element[] = [child];
      let nextNode = child.nextSibling;
      const whitespaceNodes: Node[] = [];

      while (nextNode) {
        if (nextNode.nodeType === Node.TEXT_NODE) {
          if ((nextNode.textContent || '').trim().length > 0) {
            break;
          }
          whitespaceNodes.push(nextNode);
        } else if (nextNode.nodeType === Node.COMMENT_NODE) {
          whitespaceNodes.push(nextNode);
        } else if (nextNode.nodeType === Node.ELEMENT_NODE) {
          const nextEl = nextNode as Element;
          if (isContentList(nextEl)) {
            // 根层级 (level 1) 且标签不同（如 ul 接 ol）代表不同语义独立列表，不并入同一嵌套组
            const childLevel = getListLevel(child);
            const nextLevel = getListLevel(nextEl);
            if (childLevel === 1 && nextLevel === 1 && nextEl.tagName !== child.tagName) {
              break;
            }

            group.push(nextEl);
            for (const ws of whitespaceNodes) {
              ws.parentNode?.removeChild(ws);
            }
            whitespaceNodes.length = 0;
          } else if (isKnownNoise(nextEl)) {
            whitespaceNodes.push(nextNode);
          } else {
            break;
          }
        }
        nextNode = nextNode.nextSibling;
      }

      if (group.length > 1) {
        mergeListGroup(group);
      }
      child = group[0].nextElementSibling;
    }
  }
}

/**
 * 装配微信列表转换规则（docs/conversion-rules.md §4.5）
 *
 * 1. li 内包着 p、section、div 等排版容器：
 *    微信列表项普遍结构为 <li><p style="...">...</p></li> 或 <li><section><span>...</span></section></li>。
 *    若将排版容器当独立块级段落输出 \n\n，会导致列表项之间出现多余空行成为松散列表。
 *    将 li 内部的排版容器转为紧凑内容输出，同个 li 内的多段落以正常空行分隔，保持列表整体紧凑无多余空行。
 * 2. 子列表（嵌套在 li 内的 ul/ol）：
 *    输出前缀单换行 \n 而非段落换行 \n\n，确保子列表紧凑嵌套于上级列表项下。
 *    仅拦截正文内容列表，排除代码块内部行号容器（避免行号泄漏）。
 */
export function registerListRules(service: TurndownService): void {
  service.addRule('wechatLiContainers', {
    filter: (node) => {
      const tag = node.nodeName;
      return (
        (tag === 'P' || tag === 'SECTION' || tag === 'DIV') &&
        Boolean((node as HTMLElement).closest('li'))
      );
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const hasPrev = Boolean(el.previousElementSibling);
      const next = el.nextElementSibling;
      const hasNextBlock = Boolean(next && next.nodeName !== 'UL' && next.nodeName !== 'OL');

      if (hasPrev) {
        return '\n\n' + content + (hasNextBlock ? '\n\n' : '');
      }
      return content + (hasNextBlock ? '\n\n' : '');
    },
  });

  service.addRule('wechatSubList', {
    filter: (node) => {
      const el = node as HTMLElement;
      return isContentList(el) && Boolean(el.closest('li'));
    },
    replacement: (content) => {
      return '\n' + content;
    },
  });
}
