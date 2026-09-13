import type TurndownService from 'turndown';

/**
 * 获取表格的直接 <tr> 行（排除内嵌子表格的 <tr>）
 */
export function getDirectTableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'tr') {
      rows.push(child);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const subChild of Array.from(child.children)) {
        if (subChild.tagName.toLowerCase() === 'tr') {
          rows.push(subChild);
        }
      }
    }
  }
  return rows;
}

/**
 * 判定元素是否为表格内第一行（表头行候选）
 */
function isFirstRowInTable(tr: Element): boolean {
  const table = tr.closest('table');
  if (!table) return false;

  // 若在 thead 内
  if (tr.parentElement?.tagName.toLowerCase() === 'thead') {
    return tr.parentElement.firstElementChild === tr;
  }

  // 若在 tbody 或 table 直接子级
  const rows = getDirectTableRows(table);
  return rows[0] === tr;
}

/**
 * 解析单元格对齐方式
 */
function getCellAlignment(el: Element): string {
  const alignAttr = (el.getAttribute('align') || '').toLowerCase();
  if (alignAttr === 'center') return ':-:';
  if (alignAttr === 'right') return '--:';
  if (alignAttr === 'left') return ':--';

  const style = el.getAttribute('style') || '';
  if (/text-align\s*:\s*center/i.test(style)) return ':-:';
  if (/text-align\s*:\s*right/i.test(style)) return '--:';
  if (/text-align\s*:\s*left/i.test(style)) return ':--';

  return '---';
}

/**
 * 判定表格是否包含无法可靠表达的合并单元格或复杂嵌套，需降级为可读文本
 * 对应 docs/conversion-rules.md §4.7 与 Issue #22
 *
 * 判据：
 * 1. 包含内嵌子表格（嵌套 <table>）
 * 2. 任意单元格含合并属性：colspan > 1 或 rowspan > 1
 * 3. 单元格内含无法在 GFM 单元格内表达的块级元素（列表、代码块、引用、标题等）
 * 4. 不规则行列（各行单元格数量不一致）
 */
export function isTableDegraded(table: Element): boolean {
  // 1. 复杂嵌套：包含内嵌 table
  if (table.querySelector('table')) {
    return true;
  }

  const rows = getDirectTableRows(table);
  if (rows.length === 0) return false;

  let expectedCols = -1;

  for (const tr of rows) {
    const cells = Array.from(tr.children).filter(
      (c) => c.tagName.toLowerCase() === 'th' || c.tagName.toLowerCase() === 'td'
    );
    if (cells.length === 0) continue;

    let rowCols = 0;
    for (const cell of cells) {
      // 2. 合并单元格：colspan > 1 或 rowspan > 1
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
      if (!isNaN(colspan) && colspan > 1) {
        return true;
      }
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);
      if (!isNaN(rowspan) && rowspan > 1) {
        return true;
      }

      // 3. 复杂嵌套：单元格内包含无法在 GFM 单元格内表达的块级元素
      if (
        cell.querySelector(
          'ul, ol, pre, blockquote, hr, h1, h2, h3, h4, h5, h6, [class*="code-snippet"]'
        )
      ) {
        return true;
      }

      rowCols += 1;
    }

    // 4. 不规则行列（列数不一致且无 colspan 填补）
    if (expectedCols === -1) {
      expectedCols = rowCols;
    } else if (expectedCols !== rowCols) {
      return true;
    }
  }

  return false;
}

/**
 * 将表格按行、单元格顺序降级为可读文本（保留文字、样式、链接与图片引用）
 * 对应 docs/conversion-rules.md §4.7
 */
export function degradeTableToText(table: Element, service: TurndownService): string {
  const rows = getDirectTableRows(table);
  const textRows: string[] = [];

  for (const tr of rows) {
    const cells = Array.from(tr.children).filter(
      (c) => c.tagName.toLowerCase() === 'th' || c.tagName.toLowerCase() === 'td'
    );
    if (cells.length === 0) continue;

    const cellTexts: string[] = [];
    for (const cell of cells) {
      const nestedTable = cell.querySelector('table');
      if (nestedTable) {
        const cellClone = cell.cloneNode(true) as Element;
        // 仅筛选直接子表格（排除其祖先也在其中的孙表格，避免多层嵌套重复递归提取）
        const allTables = Array.from(cellClone.querySelectorAll('table'));
        const directInnerTables = allTables.filter((tbl) => {
          let p = tbl.parentElement;
          while (p && p !== cellClone) {
            if (p.tagName.toLowerCase() === 'table') return false;
            p = p.parentElement;
          }
          return true;
        });

        const innerTexts: string[] = [];
        for (const it of directInnerTables) {
          innerTexts.push(degradeTableToText(it, service));
          it.remove();
        }
        const remainingMd = service.turndown(cellClone.innerHTML).trim();
        const combined = [remainingMd, ...innerTexts].filter(Boolean).join(' | ');
        const clean = combined.replace(/[ \t]*\n+[ \t]*/g, ' ');
        if (clean) cellTexts.push(clean);
      } else {
        const md = service.turndown(cell.innerHTML).trim();
        const clean = md.replace(/[ \t]*\n+[ \t]*/g, ' ');
        if (clean) cellTexts.push(clean);
      }
    }

    if (cellTexts.length > 0) {
      textRows.push(cellTexts.join(' | '));
    }
  }

  return textRows.join('\n');
}

/**
 * 装配表格 GFM 输出与降级规则（docs/conversion-rules.md §4.7 与 Issue #22）
 * 1. 消除 turndown-plugin-gfm 缺少 <th> 时回退原始 HTML 的缺陷
 * 2. 存在无法可靠表达的合并单元格或复杂嵌套时，降级为可读文本
 * 3. 严格禁止原始 HTML 作为保真兜底
 */
export function registerTableRules(service: TurndownService): void {
  // 1. 单元格内排版容器（p, div, section）紧凑化，支持深层包装容器，避免段落换行破坏表格行
  service.addRule('wechatTableCellContainers', {
    filter: (node) => {
      const tag = node.nodeName.toLowerCase();
      if (tag === 'p' || tag === 'div' || tag === 'section') {
        const cellAncestor = (node as HTMLElement).closest('td, th');
        return cellAncestor !== null;
      }
      return false;
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const clean = content.trim().replace(/[ \t]*\n+[ \t]*/g, '<br>');
      return el.nextElementSibling ? clean + '<br>' : clean;
    },
  });

  // 2. 单元格规则：保留显式换行为 <br>，清理多余换行、转义未转义的管道符 |
  service.addRule('wechatTableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const clean = content
        .trim()
        .replace(/[ \t]*\n+[ \t]*/g, '<br>')
        .replace(/(<br>)+/g, '<br>')
        .replace(/^(<br>)+|(<br>)+$/g, '')
        .replace(/(?<!\\)\|/g, '\\|');

      const el = node as HTMLElement;
      const siblings = Array.from(el.parentElement?.children || []).filter(
        (c) => c.tagName.toLowerCase() === 'th' || c.tagName.toLowerCase() === 'td'
      );
      const index = siblings.indexOf(el);
      const prefix = index === 0 ? '| ' : ' ';
      return prefix + clean + ' |';
    },
  });

  // 3. 表格行规则：严格仅为表格首行生成 GFM 分隔线（| --- | --- |），防止多表头或重复分隔线
  service.addRule('wechatTableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const tr = node as HTMLElement;
      const cells = Array.from(tr.children).filter(
        (c) => c.tagName.toLowerCase() === 'th' || c.tagName.toLowerCase() === 'td'
      );

      // 无单元格的空行
      if (cells.length === 0) return '';

      // 依据 GFM 规范，表格必须且只能有一行分隔线，位于首行之后
      const isHeading = isFirstRowInTable(tr);

      let delimiterRow = '';
      if (isHeading) {
        let borders = '';
        for (let i = 0; i < cells.length; i++) {
          const border = getCellAlignment(cells[i]);
          const prefix = i === 0 ? '| ' : ' ';
          borders += prefix + border + ' |';
        }
        delimiterRow = '\n' + borders;
      }

      return '\n' + content + delimiterRow;
    },
  });


  // 4. 表格容器规则：检测降级并紧凑输出，严禁原始 HTML 兜底
  service.addRule('wechatTable', {
    filter: 'table',
    replacement: (content, node) => {
      const table = node as HTMLElement;

      // 无法可靠表达的合并单元格或复杂嵌套 → 降级为可读文本
      if (isTableDegraded(table)) {
        const text = degradeTableToText(table, service);
        return '\n\n' + text.trim() + '\n\n';
      }

      const trimmed = content.trim();
      if (!trimmed) return '';
      // 避免表格内部多余空行破坏 Markdown 块语法
      const cleanTable = trimmed.replace(/\n{2,}/g, '\n');
      return '\n\n' + cleanTable + '\n\n';
    },
  });
}
