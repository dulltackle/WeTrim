import type TurndownService from 'turndown';

/**
 * 判断是否为微信官方代码块形态（docs/conversion-rules.md §4.4）
 * 官方形态特征：
 * 1. pre[data-lang] 属性
 * 2. pre 或外层容器具有 code-snippet 相关类名
 * 3. 伴有 ul.code-snippet__line-index 行号容器
 */
export function isOfficialCodeBlock(pre: HTMLElement): boolean {
  if (pre.hasAttribute('data-lang')) return true;

  const cls = (pre.getAttribute('class') || '') + ' ' + (pre.className || '');
  if (/code-snippet|code_snippet/.test(cls)) return true;

  const parent = pre.parentElement;
  if (parent) {
    const parentCls = (parent.getAttribute('class') || '') + ' ' + (parent.className || '');
    if (/code-snippet__fix|code-snippet/.test(parentCls)) return true;
    if (parent.querySelector('ul.code-snippet__line-index')) return true;
  }

  if (pre.previousElementSibling?.classList?.contains('code-snippet__line-index')) {
    return true;
  }

  return false;
}

export interface ParsedCodeResult {
  lang: string;
  code: string;
}

/**
 * 解析微信官方代码块形态（.code-snippet__fix）
 * - 语言取 pre[data-lang]，必须判空，空串按无语言处理
 * - 行号隔离在 <ul class="code-snippet__line-index">
 * - 自检 1：若存在行号容器，li 数必须 === code 数，不相等即报错
 * - 换行靠一行一个 <code>（<br> 数为 0），按 <code> 边界补 \n
 * - 缩进 &nbsp; (U+00A0) 替换为普通空格
 * - 跳过 CSS counter(line…) 泄漏的垃圾行
 */
export function parseOfficialCode(pre: HTMLElement): ParsedCodeResult {
  const rawLang = pre.getAttribute('data-lang');
  const lang = rawLang ? rawLang.trim() : '';

  // 寻找关联的行号容器
  const ul =
    (pre.parentElement?.querySelector('ul.code-snippet__line-index') as HTMLElement | null) ||
    (pre.closest?.('section.code-snippet__fix')?.querySelector('ul.code-snippet__line-index') as HTMLElement | null) ||
    (pre.previousElementSibling?.classList?.contains('code-snippet__line-index')
      ? (pre.previousElementSibling as HTMLElement)
      : null);

  const codeEls = Array.from(pre.children).filter((c) => c.nodeName === 'CODE');

  // 自检 1：官方形态 li 数 === code 数（8 个真实代码块全部成立），不相等即报错
  if (ul) {
    const lis = ul.querySelectorAll('li');
    if (lis.length !== codeEls.length) {
      throw new Error(
        `官方代码块行号校验失败：li 数 (${lis.length}) !== code 数 (${codeEls.length})`
      );
    }
  }

  let codeText = '';
  if (codeEls.length > 0) {
    const lines: string[] = [];
    for (const codeEl of codeEls) {
      let line = codeEl.textContent || '';
      // 缩进替换：U+00A0 -> 普通空格
      line = line.replace(/\u00a0/g, ' ');
      // 跳过 CSS counter(line…) 泄漏的垃圾行
      if (line.trim().startsWith('counter(line')) {
        continue;
      }
      lines.push(line);
    }
    codeText = lines.join('\n');
  } else {
    let line = pre.textContent || '';
    line = line.replace(/\u00a0/g, ' ');
    const rawLines = line.split('\n');
    const filtered = rawLines.filter((l) => !l.trim().startsWith('counter(line'));
    codeText = filtered.join('\n');
  }

  return { lang, code: codeText };
}

/**
 * 解析第三方代码块形态（pre > code）
 * - 无 data-lang，语言丢失
 * - 行号内联在代码文本里，判据只有内联样式 user-select: none，必须剔除行号节点
 * - 换行靠 <br>
 * - 空行通过剔除行号节点并保留 <br> 实现，避免两行号连成一个数（如 45）
 * - 缩进 &nbsp; (U+00A0) 替换为普通空格
 * - 跳过 CSS counter(line…) 泄漏的垃圾行
 */
export function parseThirdPartyCode(pre: HTMLElement): ParsedCodeResult {
  const clone = pre.cloneNode(true) as HTMLElement;

  // 剔除所有行号节点：判据为内联样式 user-select: none
  const allEls = Array.from(clone.querySelectorAll('*'));
  for (const el of allEls) {
    const style = el.getAttribute('style') || '';
    if (/user-select\s*:\s*none/i.test(style)) {
      el.remove();
    }
  }

  // 换行靠 <br>，将其替换为换行符 \n
  const brs = Array.from(clone.querySelectorAll('br'));
  for (const br of brs) {
    br.replaceWith('\n');
  }

  let text = clone.textContent || '';
  // 缩进替换：U+00A0 -> 普通空格
  text = text.replace(/\u00a0/g, ' ');

  const rawLines = text.split('\n');
  const cleanLines = rawLines.filter((l) => !l.trim().startsWith('counter(line'));
  const code = cleanLines.join('\n');

  // 若存在标准语言类名（如 language-python / lang-python），尝试提取；否则无语言
  let lang = '';
  const codeEl = clone.querySelector('code');
  const cls = (pre.getAttribute('class') || '') + ' ' + (codeEl?.getAttribute('class') || '');
  const langMatch = cls.match(/\b(?:language|lang)-([a-zA-Z0-9_-]+)\b/);
  if (langMatch) {
    lang = langMatch[1];
  }

  return { lang, code };
}

/**
 * 生成围栏代码块 Markdown，动态适应代码内部已有的反引号
 */
export function formatFencedCode(code: string, lang = ''): string {
  let fence = '```';
  while (code.includes(fence)) {
    fence += '`';
  }
  return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
}

/**
 * 注册代码块相关 Turndown 规则
 */
export function registerCodeRules(service: TurndownService): void {
  // 1. 官方代码块外层容器 section.code-snippet__fix：作为透明容器传递内容
  service.addRule('wechatCodeSnippetFixSection', {
    filter: (node) => {
      if (node.nodeName === 'SECTION') {
        const cls = node.getAttribute('class') || '';
        return cls.includes('code-snippet__fix');
      }
      return false;
    },
    replacement: (content) => content,
  });

  // 2. 官方代码块行号容器 ul.code-snippet__line-index：删掉即可
  service.addRule('wechatLineIndex', {
    filter: (node) => {
      if (node.nodeName === 'UL') {
        const cls = node.getAttribute('class') || '';
        return cls.includes('code-snippet__line-index');
      }
      return false;
    },
    replacement: () => '',
  });

  // 3. 避免 pre 内的一行一个 <code> 被 Turndown 默认行内 code 规则包裹反引号
  service.addRule('wechatPreCode', {
    filter: (node) => {
      return (
        node.nodeName === 'CODE' &&
        Boolean(node.parentNode && node.parentNode.nodeName === 'PRE')
      );
    },
    replacement: (content) => content,
  });

  // 4. pre 代码块转换规则（覆盖官方形态与第三方形态）
  service.addRule('wechatCodeBlock', {
    filter: 'pre',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      let parsed: ParsedCodeResult;

      if (isOfficialCodeBlock(pre)) {
        parsed = parseOfficialCode(pre);
      } else {
        parsed = parseThirdPartyCode(pre);
      }

      return formatFencedCode(parsed.code, parsed.lang);
    },
  });
}
