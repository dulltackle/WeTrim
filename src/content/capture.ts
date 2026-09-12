import type { ArticleSource, CaptureResult } from '../shared/types';

/**
 * 解码 HTML 实体
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

/**
 * 解析单个日期/时间戳值并换算为硬编码 UTC+8 的 'YYYY-MM-DD'
 * 依据 docs/conversion-rules.md §2 与 ARCHITECTURE.md §4.3
 */
export function parseDateValue(rawVal: string | null | undefined): string | null {
  if (!rawVal) return null;
  const val = decodeHtmlEntities(rawVal).trim();

  // 1. 已是日期字符串格式（如 'YYYY-MM-DD ...' 或 'YYYY年MM月DD日 ...' 或 'YYYY/MM/DD ...'）
  const dateMatch = val.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (dateMatch) {
    const year = dateMatch[1];
    const month = dateMatch[2].padStart(2, '0');
    const day = dateMatch[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // 2. 纯数字时间戳：严格区分 10 位秒 vs 13 位毫秒，其余长度视为不可靠返回 null
  if (/^\d+$/.test(val)) {
    let tsSec: number | null = null;
    if (val.length === 10) {
      tsSec = parseInt(val, 10);
    } else if (val.length === 13) {
      tsSec = Math.floor(parseInt(val, 10) / 1000);
    } else {
      return null;
    }

    // 硬编码 UTC+8 换算：加上 8 小时偏移，截取 ISO UTC 日期
    const dateUtc8 = new Date((tsSec + 8 * 3600) * 1000);
    if (isNaN(dateUtc8.getTime())) return null;
    return dateUtc8.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * 从 HTML 源码或当前 DOM 脚本中提取并解析 create_time
 */
export function parsePublishedAt(html: string, doc?: Document): string | null {
  const unescaped = decodeHtmlEntities(html);

  // 1. create_time : JsDecode('...') 形式
  const jsDecodeMatch = unescaped.match(/create_time\s*:\s*JsDecode\(['"]([^'"]+)['"]\)/);
  if (jsDecodeMatch) {
    const res = parseDateValue(jsDecodeMatch[1]);
    if (res) return res;
  }

  // 2. create_time : '1710000000' 形式
  const digitsQuoteMatch = unescaped.match(/create_time\s*:\s*['"](\d+)['"]/);
  if (digitsQuoteMatch) {
    const res = parseDateValue(digitsQuoteMatch[1]);
    if (res) return res;
  }

  // 3. create_time / ct / createTime = "1710000000" 或等号/冒号赋值
  const kvMatch = unescaped.match(/(?:var\s+)?(?:create_time|createTime|ct)\s*[:=]\s*['"]?(\d+)['"]?/);
  if (kvMatch) {
    const res = parseDateValue(kvMatch[1]);
    if (res) return res;
  }

  // 4. 日期字符串赋值
  const dateStrMatch = unescaped.match(/(?:var\s+)?(?:create_time|createTime|publish_time)\s*[:=]\s*['"](\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^'"]*)['"]/);
  if (dateStrMatch) {
    const res = parseDateValue(dateStrMatch[1]);
    if (res) return res;
  }

  // 5. DOM 中如果有 #publish_time 节点
  if (doc) {
    const publishTimeEl = doc.querySelector('#publish_time');
    if (publishTimeEl?.textContent) {
      const res = parseDateValue(publishTimeEl.textContent.trim());
      if (res) return res;
    }
  }

  return null;
}

/**
 * 稳定探测辅助量度
 */
export function measureContent(el: Element): { textLen: number; imgCount: number } {
  return {
    textLen: el.textContent?.length || 0,
    imgCount: el.querySelectorAll('img[data-src]').length,
  };
}

/**
 * 稳定探测循环（300ms 窗口稳定，上限 2000ms）
 */
export async function probeStability(
  contentEl: Element,
  options: { stableIntervalMs?: number; maxWaitMs?: number; checkIntervalMs?: number } = {}
): Promise<{ unstable: boolean; elapsedMs: number }> {
  const stableIntervalMs = options.stableIntervalMs ?? 300;
  const maxWaitMs = options.maxWaitMs ?? 2000;
  const checkIntervalMs = options.checkIntervalMs ?? 50;

  const startTime = Date.now();
  let lastMeasurement = measureContent(contentEl);
  let lastChangedAt = startTime;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, checkIntervalMs));
    const current = measureContent(contentEl);
    if (current.textLen > lastMeasurement.textLen || current.imgCount > lastMeasurement.imgCount) {
      lastMeasurement = current;
      lastChangedAt = Date.now();
    } else if (Date.now() - lastChangedAt >= stableIntervalMs) {
      return { unstable: false, elapsedMs: Date.now() - startTime };
    }
  }

  // 超时未达到稳定窗口
  const unstable = Date.now() - lastChangedAt < stableIntervalMs;
  return { unstable, elapsedMs: Date.now() - startTime };
}

/**
 * 在目标页面执行的自包含抓取函数。
 * 必须自包含全部辅助函数，以便通过 executeScript({ func: capturePage }) 序列化注入。
 */
export async function capturePage(): Promise<CaptureResult> {
  // ---- 内置自包含辅助函数（防 executeScript 跨作用域序列化丢失） ----
  function decodeEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  }

  function parseDate(rawVal: string | null | undefined): string | null {
    if (!rawVal) return null;
    const val = decodeEntities(rawVal).trim();
    const dateMatch = val.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (dateMatch) {
      const year = dateMatch[1];
      const month = dateMatch[2].padStart(2, '0');
      const day = dateMatch[3].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    if (/^\d+$/.test(val)) {
      let tsSec: number | null = null;
      if (val.length === 10) {
        tsSec = parseInt(val, 10);
      } else if (val.length === 13) {
        tsSec = Math.floor(parseInt(val, 10) / 1000);
      } else {
        return null;
      }
      const d = new Date((tsSec + 8 * 3600) * 1000);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    return null;
  }

  function extractDate(html: string): string | null {
    const unescaped = decodeEntities(html);
    const m1 = unescaped.match(/create_time\s*:\s*JsDecode\(['"]([^'"]+)['"]\)/);
    if (m1) {
      const res = parseDate(m1[1]);
      if (res) return res;
    }
    const m2 = unescaped.match(/create_time\s*:\s*['"](\d+)['"]/);
    if (m2) {
      const res = parseDate(m2[1]);
      if (res) return res;
    }
    const m3 = unescaped.match(/(?:var\s+)?(?:create_time|createTime|ct)\s*[:=]\s*['"]?(\d+)['"]?/);
    if (m3) {
      const res = parseDate(m3[1]);
      if (res) return res;
    }
    const m4 = unescaped.match(/(?:var\s+)?(?:create_time|createTime|publish_time)\s*[:=]\s*['"](\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^'"]*)['"]/);
    if (m4) {
      const res = parseDate(m4[1]);
      if (res) return res;
    }
    const ptEl = document.querySelector('#publish_time');
    if (ptEl?.textContent) {
      const res = parseDate(ptEl.textContent.trim());
      if (res) return res;
    }
    return null;
  }

  // ---- 1. 验证页检查 (/mp/wappoc_appmsgcaptcha) ----
  const currentPath = window.location.pathname || '';
  if (currentPath.includes('/mp/wappoc_appmsgcaptcha')) {
    let articleUrl: string | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      articleUrl = params.get('target_url') || window.location.href;
    } catch {
      articleUrl = window.location.href;
    }
    return {
      kind: 'captcha',
      articleUrl,
    };
  }

  // ---- 2. 检查 #js_content ----
  const contentEl = document.querySelector('#js_content');
  if (!contentEl) {
    // 微信提示页：无 #js_content 且 .weui-msg__title 存在并包含非空文本
    const noticeEl = document.querySelector('.weui-msg__title');
    const noticeText = noticeEl?.textContent?.trim() || '';
    if (noticeText) {
      return {
        kind: 'wechatNotice',
        noticeText,
        articleUrl: window.location.href,
      };
    }
    // 其余非文章页面 -> 通用失败
    return {
      kind: 'noArticle',
    };
  }

  // ---- 3. #js_content 存在：进入稳定探测 (300ms 稳定窗口，上限 2000ms) ----
  function measure(el: Element) {
    return {
      textLen: el.textContent?.length || 0,
      imgCount: el.querySelectorAll('img[data-src]').length,
    };
  }

  const STABLE_INTERVAL_MS = 300;
  const MAX_WAIT_MS = 2000;
  const CHECK_INTERVAL_MS = 50;

  const startTime = Date.now();
  let lastMeasurement = measure(contentEl);
  let lastChangedAt = startTime;
  let unstable = false;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    const current = measure(contentEl);
    if (current.textLen > lastMeasurement.textLen || current.imgCount > lastMeasurement.imgCount) {
      lastMeasurement = current;
      lastChangedAt = Date.now();
    } else if (Date.now() - lastChangedAt >= STABLE_INTERVAL_MS) {
      unstable = false;
      break;
    }
  }

  if (Date.now() - startTime >= MAX_WAIT_MS && Date.now() - lastChangedAt < STABLE_INTERVAL_MS) {
    unstable = true;
  }

  // ---- 4. 提取文章元数据与正文 HTML ----
  const title = document.querySelector('#activity-name')?.textContent?.trim() || '';
  const account = document.querySelector('#js_name')?.textContent?.trim() || null;
  const publishedAt = extractDate(document.documentElement.innerHTML);
  const contentHtml = contentEl.outerHTML;

  const source: ArticleSource = {
    title,
    account,
    publishedAt,
    url: window.location.href,
  };

  return {
    kind: 'article',
    source,
    contentHtml,
    unstable,
  };
}
