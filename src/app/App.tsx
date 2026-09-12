import React, { useEffect, useState, useMemo } from 'react';
import type { CaptureResult, Block, ArticleSnapshot, CandidateRecord } from '../shared/types';
import { STORAGE_KEYS } from '../shared/storage-keys';
import { PENDING_CAPTURE_MESSAGE_TYPE } from '../shared/messages';
import {
  verifyTurndownTable,
  buildArticleSnapshot,
  convertBlock,
  convertBlocks,
  createTurndown,
} from './parse/convert';
import { BlockList } from './components/BlockList';
import { renderMarkdown } from './preview/render';
import './app.css';

/**
 * 依据 ARCHITECTURE.md §4.1 ~ §4.4、§6.2，ADR-0001 与 docs/conversion-rules.md：
 * 视觉世界：校验与校对符号 · Operate 模式
 *
 * 全页状态呈现：
 * 1. 空状态 (3 步指引，待稿)
 * 2. 稿件审读签条 (kind === 'article'，含元数据、体量统计、切块列表展示)
 * 3. 整篇级失败状态 (切块器抛错 / 无法解析 DOM / 找不到 #js_content，通用提示 + 重试，不写 candidateSnapshot)
 * 4. 审校退单 (kind === 'wechatNotice' | 'captcha'，原样转述文案，配「回到原文看看」与「重试」)
 * 5. 页边浮贴夹签 (kind === 'noArticle'，受限页误触，非模态提示「刚才那个页面上没有公众号文章，你的进度没有被动过」)
 */
export const App: React.FC = () => {
  const [selfTestPassed, setSelfTestPassed] = useState(false);
  const [activeArticle, setActiveArticle] = useState<Extract<CaptureResult, { kind: 'article' }> | null>(null);
  const [activeNotice, setActiveNotice] = useState<Extract<CaptureResult, { kind: 'wechatNotice' | 'captcha' }> | null>(null);
  const [marginClipNote, setMarginClipNote] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);

  // 1. marked + DOMPurify 真实渲染三步文案（Markdown 源格式）
  const stepsMarkdown = `1. **用浏览器打开一篇公众号文章**\\n2. **等它显示完**\\n3. **点工具栏上的 WeTrim 图标** 开始清洗`;
  const renderedStepsHtml = renderMarkdown(stepsMarkdown);

  // 自检验证（CSP 与 eval 约束验证）
  useEffect(() => {
    try {
      const tableMd = verifyTurndownTable();
      console.log(
        '[WeTrim Self-Test] Production CSP & eval verification passed: React 19, Turndown, turndown-plugin-gfm, marked, DOMPurify OK.\\n' +
          'Table conversion fixture result:\\n' +
          tableMd
      );
      setSelfTestPassed(true);

      // 暴露测试辅助钩子（仅用于自动化测试验证）
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__wetrim = {
          buildArticleSnapshot,
          convertBlock,
          convertBlocks,
          createTurndown,
        };
      }
    } catch (err) {
      console.error('[WeTrim Self-Test] Evaluation failed:', err);
    }
  }, []);

  // 消费 pendingCapture 逻辑：读到后必须立即删除该 key，防止重复消费
  const checkPendingCapture = async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
      const pending = data[STORAGE_KEYS.PENDING_CAPTURE] as { result: CaptureResult } | undefined;
      if (pending && pending.result) {
        // 立即删除该 key
        await chrome.storage.local.remove(STORAGE_KEYS.PENDING_CAPTURE);

        const res = pending.result;
        if (res.kind === 'article') {
          setActiveArticle(res);
          setActiveNotice(null);
          setSplitError(null);
        } else if (res.kind === 'wechatNotice' || res.kind === 'captcha') {
          setActiveNotice(res);
          setActiveArticle(null);
          setSplitError(null);
        } else if (res.kind === 'noArticle') {
          setMarginClipNote('刚才那个页面上没有公众号文章，你的进度没有被动过');
        }
      }
    } catch (err) {
      console.warn('[WeTrim] Error reading pendingCapture:', err);
    }
  };

  // 挂载检查以及监听来自 background 的叫醒消息
  useEffect(() => {
    checkPendingCapture();

    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
      return;
    }

    const messageListener = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === PENDING_CAPTURE_MESSAGE_TYPE) {
        checkPendingCapture();
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  // 页边浮贴夹签（Margin Clip Note）自动轻微收回（4 秒）
  useEffect(() => {
    if (marginClipNote) {
      const timer = setTimeout(() => {
        setMarginClipNote(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [marginClipNote]);

  // 转换与快照组装：切块 -> 逐块独立转换 -> 收集图片 -> 组装 ArticleSnapshot
  // ARCHITECTURE.md §4.5、§6.2:
  // - 组装 ArticleSnapshot 并写入 candidateSnapshot
  // - 若发生整篇级失败（如切块器整体抛错），不写 candidateSnapshot、不动 currentSession，走通用提示 + 重试
  // - 单块级失败降级为 unknown 块，候选照常写入
  const [snapshot, setSnapshot] = useState<ArticleSnapshot | null>(null);

  useEffect(() => {
    if (!activeArticle) {
      setSnapshot(null);
      setSplitError(null);
      return;
    }

    try {
      const articleSnapshot = buildArticleSnapshot(activeArticle);
      setSnapshot(articleSnapshot);
      setSplitError(null);

      // 先落盘，写入 candidateSnapshot（ARCHITECTURE.md §4.5）
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const candidateRecord: CandidateRecord = {
          schemaVersion: 1,
          snapshot: articleSnapshot,
          savedAt: new Date().toISOString(),
        };
        chrome.storage.local
          .set({
            [STORAGE_KEYS.CANDIDATE_SNAPSHOT]: candidateRecord,
          })
          .catch((err: unknown) => {
            console.error('[WeTrim] Failed to persist candidateSnapshot:', err);
          });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[WeTrim] buildArticleSnapshot error:', err);
      setSplitError(msg);
      setSnapshot(null);
    }
  }, [activeArticle]);

  const blocks: Block[] | null = snapshot?.blocks || null;

  // 计算文章体量概览（字数、HTML 体积 KB、图片数）
  const volumeStats = useMemo(() => {
    if (!activeArticle) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(activeArticle.contentHtml, 'text/html');
    const text = doc.body.textContent || '';
    const charCount = text.trim().length;
    const htmlBytes = new Blob([activeArticle.contentHtml]).size;
    const htmlKb = (htmlBytes / 1024).toFixed(1);
    const imgCount = doc.querySelectorAll('img').length;
    return { charCount, htmlKb, imgCount };
  }, [activeArticle]);

  // 「回到原文看看」：优先聚焦原标签页；若已关闭则打开原 URL
  const handleReturnToOriginal = async (tabId?: number, url?: string | null) => {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof tabId === 'number') {
      try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== undefined && chrome.windows) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      } catch {
        // 原标签页可能已关闭，降级为新建标签页打开
      }
    }
    if (url) {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        await chrome.tabs.create({ url });
      } else {
        window.open(url, '_blank');
      }
    }
  };

  // 「重试」：通知 background 对目标标签页发起重新抓取探测
  const handleRetry = async (tabId?: number) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    try {
      setSplitError(null);
      await chrome.runtime.sendMessage({ type: 'retry-capture', tabId });
    } catch (err) {
      console.warn('[WeTrim] Retry request failed:', err);
    }
  };

  return (
    <div className="app-container" data-csp-eval-verified={selfTestPassed ? 'true' : 'false'}>
      {/* 顶部工作台状态条 */}
      <header className="workbench-header">
        <div className="ticket-slug">
          <span className="ticket-tag">
            {activeArticle ? '校样' : activeNotice ? '退单' : '待稿'}
          </span>
          <span className="ticket-number">
            {activeArticle?.source.title
              ? `WE-TRIM // ${activeArticle.source.title.slice(0, 16)}...`
              : 'WE-TRIM // 001'}
          </span>
        </div>
        <div className="system-status">
          <span
            className="status-dot"
            style={{
              backgroundColor: splitError
                ? '#c8352b'
                : activeArticle
                ? '#07c160'
                : activeNotice
                ? '#fa9d3b'
                : '#2f5fa8',
            }}
          ></span>
          <span>
            {splitError
              ? '整篇解析异常'
              : activeArticle
              ? '切块就绪'
              : activeNotice
              ? '等待处置'
              : '工作台就绪'}
          </span>
        </div>
      </header>

      {/* 页边浮贴夹签（Margin Clip Note，受限页误触时的非模态通知） */}
      {marginClipNote && (
        <aside
          className="margin-clip-note"
          role="status"
          aria-live="polite"
          data-testid="margin-clip-note"
        >
          <div className="clip-pin" aria-hidden="true"></div>
          <div className="clip-content">
            <span className="clip-text">{marginClipNote}</span>
            <button
              className="clip-close-btn"
              onClick={() => setMarginClipNote(null)}
              aria-label="关闭提示"
              type="button"
            >
              ×
            </button>
          </div>
        </aside>
      )}

      {/* 主校样纸张 */}
      <main className="proof-sheet">
        {/* 四角套准十字线 */}
        <div className="reg-cross reg-top-left" aria-hidden="true"></div>
        <div className="reg-cross reg-top-right" aria-hidden="true"></div>
        <div className="reg-cross reg-bottom-left" aria-hidden="true"></div>
        <div className="reg-cross reg-bottom-right" aria-hidden="true"></div>

        {/* 顶部色标条 */}
        <div className="registration-bar">
          <div className="cmyk-swatches">
            <span className="cmyk-swatch" style={{ backgroundColor: '#00A3E0' }} title="Cyan"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#E4007C' }} title="Magenta"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#FFD100' }} title="Yellow"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#1A1A18' }} title="Black"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#C8352B' }} title="Vermilion"></span>
            <span className="cmyk-swatch" style={{ backgroundColor: '#2F5FA8' }} title="Prussian Blue"></span>
          </div>
          <div className="proof-marks-info">PROOF SHEET · SPEC V1.0 · OPERATE</div>
        </div>

        <div className="sheet-body">
          {/* 左侧页边批注栏 */}
          <aside className="margin-track" aria-label="批注栏">
            <div className="track-header">批注 · 痕迹</div>
            <div className="track-stub"></div>
            <div className="line-numbers">
              <span>01</span>
            </div>
          </aside>

          {/* 右侧版心 */}
          <section className="main-bed">
            {/* 状态 1: 整篇级失败（ARCHITECTURE.md §6.2：通用提示 + 重试，不写候选快照） */}
            {splitError && activeArticle && (
              <div className="article-failure-card" data-testid="article-failure-card">
                <div className="notice-stamp error-stamp" aria-hidden="true">
                  <span>异常</span>
                </div>
                <div className="notice-header">
                  <span className="notice-sub">整篇级失败</span>
                  <h2 className="notice-title">无法切分文章正文块</h2>
                </div>
                <blockquote className="notice-verbatim-quote">
                  无法从当前页面解析出正文内容（{splitError}）。请回到原文看看页面是否完整加载，然后重试。
                </blockquote>
                <div className="notice-actions">
                  <button
                    type="button"
                    className="action-btn action-return"
                    onClick={() => handleReturnToOriginal(activeArticle.tabId, activeArticle.source.url)}
                  >
                    回到原文看看
                  </button>
                  <button
                    type="button"
                    className="action-btn action-retry"
                    onClick={() => handleRetry(activeArticle.tabId)}
                  >
                    重试
                  </button>
                </div>
              </div>
            )}

            {/* 状态 2: 抓取成功且切块成功 - 稿件审读签条 (Manuscript Slip) */}
            {!splitError && activeArticle && (
              <div className="manuscript-slip" data-testid="manuscript-slip">
                {/* 稳定探测超时标注夹签 */}
                {activeArticle.unstable && (
                  <div className="unstable-note" data-testid="unstable-note">
                    <span className="note-badge">批注</span>
                    <span>文章可能还没显示完整，可以回到原文等它加载完再重新抓一次</span>
                  </div>
                )}

                <div className="slip-header">
                  <span className="slip-kicker">文稿录入单</span>
                  <h1 className="slip-title">{activeArticle.source.title || '无标题文章'}</h1>
                  <div className="slip-meta">
                    {activeArticle.source.account && (
                      <span className="meta-item meta-account">
                        <strong>公众号：</strong>
                        {activeArticle.source.account}
                      </span>
                    )}
                    {activeArticle.source.publishedAt && (
                      <span className="meta-item meta-date">
                        <strong>发布时间：</strong>
                        {activeArticle.source.publishedAt}
                      </span>
                    )}
                  </div>
                </div>

                {/* 体量与切块概览 */}
                {volumeStats && (
                  <div className="volume-stats-grid">
                    <div className="stat-card">
                      <span className="stat-label">字符数</span>
                      <span className="stat-value">{volumeStats.charCount.toLocaleString()} 字</span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-label">HTML 载荷</span>
                      <span className="stat-value">{volumeStats.htmlKb} KB</span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-label">预加载图片</span>
                      <span className="stat-value">{volumeStats.imgCount} 张图片</span>
                    </div>
                    {blocks && (
                      <div className="stat-card" data-testid="blocks-stat-card">
                        <span className="stat-label">内容块数</span>
                        <span className="stat-value">{blocks.length} 块</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 底部操作行 */}
                <div className="slip-actions">
                  <button
                    type="button"
                    className="action-btn action-return"
                    onClick={() => handleReturnToOriginal(activeArticle.tabId, activeArticle.source.url)}
                  >
                    回到原文看看
                  </button>
                  <button
                    type="button"
                    className="action-btn action-retry"
                    onClick={() => handleRetry(activeArticle.tabId)}
                  >
                    重新抓取
                  </button>
                </div>

                {/* 正文块流列表：ADR-0005 唯一渲染入口 */}
                {blocks && <BlockList blocks={blocks} />}
              </div>
            )}

            {/* 状态 3: 微信提示页或验证页 - 审校退单 (Block / Return Notice) */}
            {activeNotice && (
              <div className="return-notice-card" data-testid="return-notice-card">
                <div className="notice-stamp" aria-hidden="true">
                  <span>退单</span>
                </div>
                <div className="notice-header">
                  <span className="notice-sub">审校退单记录</span>
                  <h2 className="notice-title">
                    {activeNotice.kind === 'captcha' ? '微信需要安全验证' : '微信页面返回提示'}
                  </h2>
                </div>

                <blockquote className="notice-verbatim-quote">
                  {activeNotice.kind === 'captcha'
                    ? '微信需要安全验证。请回到原文标签页完成滑块验证后，再点图标重试。WeTrim 不代替你完成验证。'
                    : `“${activeNotice.noticeText}”`}
                </blockquote>

                <div className="notice-actions">
                  <button
                    type="button"
                    className="action-btn action-return"
                    onClick={() => handleReturnToOriginal(activeNotice.tabId, activeNotice.articleUrl)}
                  >
                    回到原文看看
                  </button>
                  <button
                    type="button"
                    className="action-btn action-retry"
                    onClick={() => handleRetry(activeNotice.tabId)}
                  >
                    重试
                  </button>
                </div>
              </div>
            )}

            {/* 状态 4: 空状态 - 3 步指引 */}
            {!activeArticle && !activeNotice && (
              <div className="empty-state-view" data-testid="empty-state-view">
                <h1 className="empty-headline">
                  <span className="empty-headline-accent"></span>
                  从一篇公众号文章开始
                </h1>

                <div className="steps-container">
                  <div
                    className="rendered-steps"
                    dangerouslySetInnerHTML={{ __html: renderedStepsHtml }}
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* 底部印厂信息与自检证明 */}
        <footer className="proof-footer">
          <span>WETRIM MV3 ENGINE</span>
          {selfTestPassed && (
            <span className="proof-stamp" data-testid="self-test-status">
              ✓ CSP / EVAL VERIFIED (TURNDOWN + GFM + MARKED + DOMPURIFY + REACT 19)
            </span>
          )}
        </footer>
      </main>
    </div>
  );
};
