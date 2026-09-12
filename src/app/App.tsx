import React, { useEffect, useState, useMemo } from 'react';
import type { CaptureResult } from '../shared/types';
import { STORAGE_KEYS } from '../shared/storage-keys';
import { PENDING_CAPTURE_MESSAGE_TYPE } from '../shared/messages';
import { verifyTurndownTable } from './parse/convert';
import { renderMarkdown } from './preview/render';
import './app.css';

/**
 * 依据 ARCHITECTURE.md §4.1 ~ §4.3 与 output/tmp/issue16-brief.md：
 * 视觉世界：校样与校对符号 · Operate 模式
 *
 * 全页四种呈现状态：
 * 1. 空状态 (3 步指引，待稿)
 * 2. 稿件审读签条 (kind === 'article'，含元数据、体量统计、unstable 批注夹签)
 * 3. 审校退单 (kind === 'wechatNotice' | 'captcha'，原样转述文案，配「回到原文看看」与「重试」)
 * 4. 页边浮贴夹签 (kind === 'noArticle'，受限页误触，非模态提示「刚才那个页面上没有公众号文章，你的进度没有被动过」)
 */
export const App: React.FC = () => {
  const [selfTestPassed, setSelfTestPassed] = useState(false);
  const [activeArticle, setActiveArticle] = useState<Extract<CaptureResult, { kind: 'article' }> | null>(null);
  const [activeNotice, setActiveNotice] = useState<Extract<CaptureResult, { kind: 'wechatNotice' | 'captcha' }> | null>(null);
  const [marginClipNote, setMarginClipNote] = useState<string | null>(null);

  // 1. marked + DOMPurify 真实渲染三步文案（Markdown 源格式）
  const stepsMarkdown = `1. **用浏览器打开一篇公众号文章**\n2. **等它显示完**\n3. **点工具栏上的 WeTrim 图标** 开始清洗`;
  const renderedStepsHtml = renderMarkdown(stepsMarkdown);

  // 自检验证（CSP 与 eval 约束验证）
  useEffect(() => {
    try {
      const tableMd = verifyTurndownTable();
      console.log(
        '[WeTrim Self-Test] Production CSP & eval verification passed: React 19, Turndown, turndown-plugin-gfm, marked, DOMPurify OK.\n' +
          'Table conversion fixture result:\n' +
          tableMd
      );
      setSelfTestPassed(true);
    } catch (err) {
      console.error('[WeTrim Self-Test] Evaluation failed:', err);
    }
  }, []);

  // 消费 pendingCapture 逻辑：读到后必须立即删除该 key，防止重复消费
  const checkPendingCapture = async () => {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
      const pending = data[STORAGE_KEYS.PENDING_CAPTURE] as { result: CaptureResult } | undefined;
      if (pending && pending.result) {
        // 立即删除该 key
        await chrome.storage.local.remove(STORAGE_KEYS.PENDING_CAPTURE);

        const res = pending.result;
        if (res.kind === 'article') {
          setActiveArticle(res);
          setActiveNotice(null);
        } else if (res.kind === 'wechatNotice' || res.kind === 'captcha') {
          setActiveNotice(res);
          setActiveArticle(null);
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
    if (typeof tabId === 'number') {
      try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      } catch {
        // 原标签页可能已关闭，降级为新建标签页打开
      }
    }
    if (url) {
      await chrome.tabs.create({ url });
    }
  };

  // 「重试」：通知 background 对目标标签页发起重新抓取探测
  const handleRetry = async (tabId?: number) => {
    try {
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
              backgroundColor: activeArticle ? '#07c160' : activeNotice ? '#fa9d3b' : '#2f5fa8',
            }}
          ></span>
          <span>{activeArticle ? '校对就绪' : activeNotice ? '等待处置' : '工作台就绪'}</span>
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
            {/* 状态 1: 抓取成功 - 稿件审读签条 (Manuscript Slip) */}
            {activeArticle && (
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

                {/* 体量概览 */}
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
                  </div>
                )}

                {/* 底部操作与切块待命说明 */}
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

                <div className="content-outline-placeholder">
                  <div className="outline-bar"></div>
                  <span>正文抓取完成，已安全落盘。正文块流将在后续工序切分展开。</span>
                </div>
              </div>
            )}

            {/* 状态 2: 微信提示页或验证页 - 审校退单 (Block / Return Notice) */}
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

            {/* 状态 3: 空状态 - 3 步指引 */}
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
