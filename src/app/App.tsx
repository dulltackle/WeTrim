import React, { useEffect, useReducer, useRef } from 'react';
import type { CaptureResult, CandidateRecord, Session } from '../shared/types';
import { STORAGE_KEYS } from '../shared/storage-keys';
import { PENDING_CAPTURE_MESSAGE_TYPE } from '../shared/messages';
import {
  verifyTurndownTable,
  buildArticleSnapshot,
  convertBlock,
  convertBlocks,
  createTurndown,
} from './parse/convert';
import { splitBlocks } from './parse/split-blocks';
import { BlockList, type BlockListHandle } from './components/BlockList';
import { renderMarkdown } from './preview/render';
import { buildMarkdown } from './export/build-markdown';
import { truncateGraphemes } from '../shared/grapheme';
import { AppContext } from './state/session-context';
import {
  initialAppState,
  sessionReducer,
} from './state/session-reducer';
import {
  sessionSaveQueue,
  SessionSaveQueue,
  loadSession,
  saveSessionDirect,
  clearSessionDirect,
} from './state/persistence';
import './app.css';

/**
 * 依据 ARCHITECTURE.md §4.1 ~ §4.5、§7、§8.5，ADR-0005 与 Issue #24：
 * 视觉世界：延续「校对纸/印厂签条」语言 · Operate 模式
 *
 * App 顶层单 useReducer + Context 四态状态机：
 * 1. empty（空态）：3 步指引、微信提示页、验证页、整篇级失败卡片、无文章浮贴夹签
 * 2. cleaning（清洗态）：文章来源与标题位于正文之前，BlockList 连续渲染全部块
 * 3. candidateConfirm（候选确认态）：已有会话时新抓取快照待确认替换（#24 留壳，#28 实现）
 * 4. corruptedRecord（损坏记录态）：存储记录格式损坏或无法识别（#24 留壳，#35 实现）
 */
export const App: React.FC = () => {
  const [state, dispatch] = useReducer(sessionReducer, initialAppState);
  const blockListRef = useRef<BlockListHandle>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 1. marked + DOMPurify 真实渲染三步指引文案
  const stepsMarkdown = `1. **用浏览器打开一篇公众号文章**\\n2. **等它显示完**\\n3. **点工具栏上的 WeTrim 图标** 开始清洗`;
  const renderedStepsHtml = renderMarkdown(stepsMarkdown);

  // 消费 pendingCapture 逻辑：读到后必须立即删除该 key，防止重复消费
  const processCaptureResult = (res: CaptureResult) => {
    if (res.kind === 'article') {
      try {
        const articleSnapshot = buildArticleSnapshot(res);

        if (!stateRef.current.session) {
          // 无当前会话：直接提升为当前会话并入队持久化
          const newSession: Session = {
            schemaVersion: 1,
            sessionId: crypto.randomUUID(),
            snapshot: articleSnapshot,
            revision: 1,
            savedAt: new Date().toISOString(),
          };
          sessionSaveQueue.enqueue(newSession);
          dispatch({ type: 'SET_NEW_SESSION', payload: newSession });
        } else {
          // 先落盘，写入 candidateSnapshot（ARCHITECTURE.md §4.5）
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const candidateRecord: CandidateRecord = {
              schemaVersion: 1,
              snapshot: articleSnapshot,
              savedAt: new Date().toISOString(),
            };
            chrome.storage.local
              .set({ [STORAGE_KEYS.CANDIDATE_SNAPSHOT]: candidateRecord })
              .catch((err: unknown) => {
                console.error('[WeTrim] Failed to persist candidateSnapshot:', err);
              });
          }
          dispatch({ type: 'SET_ARTICLE_SNAPSHOT', payload: articleSnapshot });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[WeTrim] buildArticleSnapshot error:', err);
        dispatch({
          type: 'SET_SPLIT_ERROR',
          payload: { message: msg, tabId: res.tabId, url: res.source.url },
        });
      }
    } else if (res.kind === 'wechatNotice' || res.kind === 'captcha') {
      dispatch({ type: 'SET_EMPTY_NOTICE', payload: res });
    } else if (res.kind === 'noArticle') {
      dispatch({
        type: 'SET_MARGIN_CLIP_NOTE',
        payload: '刚才那个页面上没有公众号文章，你的进度没有被动过',
      });
    }
  };

  const checkPendingCapture = async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
      const pending = data[STORAGE_KEYS.PENDING_CAPTURE] as { result: CaptureResult } | undefined;
      if (pending && pending.result) {
        // 立即删除该 key
        await chrome.storage.local.remove(STORAGE_KEYS.PENDING_CAPTURE);
        processCaptureResult(pending.result);
      }
    } catch (err) {
      console.warn('[WeTrim] Error reading pendingCapture:', err);
    }
  };

  // 启动初始化：从 storage 读取当前会话或候选快照，驱动初始四态判定
  useEffect(() => {
    const initStorage = async () => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage?.local) {
          return;
        }
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.CURRENT_SESSION,
          STORAGE_KEYS.CANDIDATE_SNAPSHOT,
        ]);

        const rawSession = data[STORAGE_KEYS.CURRENT_SESSION] as Session | undefined;
        const rawCandidate = data[STORAGE_KEYS.CANDIDATE_SNAPSHOT] as CandidateRecord | undefined;

        let corrupted = false;
        let corruptedDetails = '';

        if (rawSession && (!rawSession.sessionId || !rawSession.snapshot)) {
          corrupted = true;
          corruptedDetails = '存储中的清洗会话记录格式不完整或损坏';
        }

        let initialSession: Session | null = corrupted ? null : (rawSession ?? null);

        if (rawSession && !corrupted) {
          sessionSaveQueue.initLoaded(rawSession);
        } else if (!rawSession && rawCandidate?.snapshot) {
          const newSession: Session = {
            schemaVersion: 1,
            sessionId: crypto.randomUUID(),
            snapshot: rawCandidate.snapshot,
            revision: 1,
            savedAt: new Date().toISOString(),
          };
          sessionSaveQueue.enqueue(newSession);
          initialSession = newSession;
        }

        dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: initialSession,
            candidateSnapshot: rawCandidate?.snapshot ?? null,
            corrupted,
            corruptedDetails,
          },
        });
      } catch (err) {
        console.warn('[WeTrim] Error initializing storage state:', err);
      }
    };

    initStorage().then(() => {
      checkPendingCapture();
    });

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

  // 订阅持久化队列状态变更
  useEffect(() => {
    const unsubscribe = sessionSaveQueue.subscribe((status, meta) => {
      dispatch({
        type: 'SET_SAVE_STATUS',
        payload: {
          status,
          lastSavedRevision: meta?.revision,
        },
      });
    });
    return unsubscribe;
  }, []);

  // 隐藏页面时尽早提交待保存内容（ARCHITECTURE.md §8.2）
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        sessionSaveQueue.flush();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 监听会话变更，修订号递增（取舍/还原立即提交）自动入队写入
  const prevSessionRef = useRef<Session | null>(null);
  useEffect(() => {
    if (!state.session) {
      prevSessionRef.current = null;
      return;
    }

    const prev = prevSessionRef.current;
    prevSessionRef.current = state.session;

    // 初始由 initLoaded 初始化的已有会话不重复入队
    if (!prev) {
      return;
    }

    if (state.session.sessionId !== prev.sessionId) {
      sessionSaveQueue.enqueue(state.session);
      return;
    }

    if (state.session.revision > prev.revision) {
      sessionSaveQueue.enqueue(state.session);
    }
  }, [state.session]);

  // 自检验证（CSP 与 eval 约束验证）
  useEffect(() => {
    try {
      const tableMd = verifyTurndownTable();
      console.log(
        '[WeTrim Self-Test] Production CSP & eval verification passed: React 19, Turndown, turndown-plugin-gfm, marked, DOMPurify OK.\\n' +
          'Table conversion fixture result:\\n' +
          tableMd
      );
      dispatch({ type: 'SET_SELF_TEST_PASSED', payload: true });

      // 暴露测试辅助钩子（供自动化测试直接调用）
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__wetrim = {
          buildArticleSnapshot,
          buildMarkdown,
          truncateGraphemes,
          convertBlock,
          convertBlocks,
          createTurndown,
          renderMarkdown,
          splitBlocks,
          blockListRef,
          dispatch,
          processCaptureResult,
          sessionSaveQueue,
          SessionSaveQueue,
          loadSession,
          saveSessionDirect,
          clearSessionDirect,
        };
      }
    } catch (err) {
      console.error('[WeTrim Self-Test] Evaluation failed:', err);
    }
  }, []);

  // 页边浮贴夹签（Margin Clip Note）自动轻微收回（4 秒）
  useEffect(() => {
    if (state.emptySubState.marginClipNote) {
      const timer = setTimeout(() => {
        dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: null });
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [state.emptySubState.marginClipNote]);

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
      dispatch({ type: 'SET_SPLIT_ERROR', payload: null });
      await chrome.runtime.sendMessage({ type: 'retry-capture', tabId });
    } catch (err) {
      console.warn('[WeTrim] Retry request failed:', err);
    }
  };

  // 保存失败时的重试处理
  const handleRetrySave = () => {
    if (state.session) {
      sessionSaveQueue.retry(state.session);
    }
  };

  const { viewMode, session, candidateSnapshot, corruptedDetails, emptySubState, selfTestPassed, saveStatus } = state;

  const saveStatusTextMap: Record<Exclude<typeof saveStatus, 'error'>, string> = {
    saving: '正在保存',
    unsaved: '最新更改未保存',
    saved: '已保存',
  };
  const saveStatusText = saveStatus === 'error' ? '' : saveStatusTextMap[saveStatus];

  // 顶部工作台状态计算
  const ticketTag =
    viewMode === 'cleaning'
      ? '校样'
      : viewMode === 'candidateConfirm'
      ? '候选'
      : viewMode === 'corruptedRecord'
      ? '损坏'
      : emptySubState.notice
      ? '退单'
      : emptySubState.splitError
      ? '异常'
      : '待稿';

  const ticketNumber =
    session?.snapshot.source.title
      ? `WE-TRIM // ${session.snapshot.source.title.slice(0, 16)}...`
      : candidateSnapshot?.source.title
      ? `WE-TRIM // ${candidateSnapshot.source.title.slice(0, 16)}...`
      : 'WE-TRIM // 001';

  const statusDotColor =
    viewMode === 'cleaning'
      ? '#07c160'
      : viewMode === 'candidateConfirm'
      ? '#fa9d3b'
      : viewMode === 'corruptedRecord' || emptySubState.splitError
      ? '#c8352b'
      : emptySubState.notice
      ? '#fa9d3b'
      : '#2f5fa8';

  const statusText =
    viewMode === 'cleaning'
      ? '正在清洗'
      : viewMode === 'candidateConfirm'
      ? '等待确认'
      : viewMode === 'corruptedRecord'
      ? '记录损坏'
      : emptySubState.splitError
      ? '整篇解析异常'
      : emptySubState.notice
      ? '等待处置'
      : '工作台就绪';

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <div
        className="app-container"
        data-csp-eval-verified={selfTestPassed ? 'true' : 'false'}
        data-view-mode={viewMode}
      >
        {/* 顶部工作台状态条 */}
        <header className="workbench-header" data-testid="workbench-header">
          <div className="ticket-slug">
            <span className="ticket-tag">{ticketTag}</span>
            <span className="ticket-number">{ticketNumber}</span>
          </div>
          <div className="header-status-group" data-testid="header-status-group">
            {/* 保存状态指示位 */}
            {session && (
              saveStatus === 'error' ? (
                <button
                  type="button"
                  className="save-status save-status-error"
                  data-testid="save-status"
                  data-save-status="error"
                  onClick={handleRetrySave}
                  title="点击重新保存"
                  aria-label="保存失败，点击重试"
                  role="status"
                  aria-live="polite"
                >
                  <span className="save-status-dot save-status-dot-error" aria-hidden="true"></span>
                  <span className="save-status-text">保存失败 · 点击重试</span>
                </button>
              ) : (
                <div
                  className={`save-status save-status-${saveStatus}`}
                  data-testid="save-status"
                  data-save-status={saveStatus}
                  role="status"
                  aria-live="polite"
                >
                  <span
                    className={`save-status-dot save-status-dot-${saveStatus}`}
                    aria-hidden="true"
                  ></span>
                  <span className="save-status-text">{saveStatusText}</span>
                </div>
              )
            )}
            <div className="system-status" data-testid="system-status">
              <span
                className="status-dot"
                style={{ backgroundColor: statusDotColor }}
              ></span>
              <span>{statusText}</span>
            </div>
          </div>
        </header>

        {/* 页边浮贴夹签（Margin Clip Note，受限页误触时的非模态通知） */}
        {emptySubState.marginClipNote && (
          <aside
            className="margin-clip-note"
            role="status"
            aria-live="polite"
            data-testid="margin-clip-note"
          >
            <div className="clip-pin" aria-hidden="true"></div>
            <div className="clip-content">
              <span className="clip-text">{emptySubState.marginClipNote}</span>
              <button
                className="clip-close-btn"
                onClick={() => dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: null })}
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
              {/* 态 1: 清洗态 (viewMode === 'cleaning') */}
              {viewMode === 'cleaning' && session && (
                <div className="manuscript-slip" data-testid="manuscript-slip">
                  {/* 稳定探测超时标注夹签 */}
                  {session.snapshot.captureWarnings?.some((w) => w.code === 'unstable-capture') && (
                    <div className="unstable-note" data-testid="unstable-note">
                      <span className="note-badge">批注</span>
                      <span>文章可能还没显示完整，可以回到原文等它加载完再重新抓一次</span>
                    </div>
                  )}

                  {/* 文章来源与标题：必须位于正文内容块之前 */}
                  <div className="slip-header" data-testid="slip-header">
                    <span className="slip-kicker">文稿录入单</span>
                    <h1 className="slip-title">{session.snapshot.source.title || '无标题文章'}</h1>
                    <div className="slip-meta">
                      {session.snapshot.source.account && (
                        <span className="meta-item meta-account">
                          <strong>公众号：</strong>
                          {session.snapshot.source.account}
                        </span>
                      )}
                      {session.snapshot.source.publishedAt && (
                        <span className="meta-item meta-date">
                          <strong>发布时间：</strong>
                          {session.snapshot.source.publishedAt}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 顶部操作行 */}
                  <div className="slip-actions">
                    <button
                      type="button"
                      className="action-btn action-return"
                      onClick={() => handleReturnToOriginal(undefined, session.snapshot.source.url)}
                    >
                      回到原文看看
                    </button>
                    <button
                      type="button"
                      className="action-btn action-retry"
                      onClick={() => handleRetry()}
                    >
                      重新抓取
                    </button>
                  </div>

                  {/* 正文块流列表：ADR-0005 唯一渲染入口 */}
                  <BlockList ref={blockListRef} blocks={session.snapshot.blocks} />
                </div>
              )}

              {/* 态 2: 候选确认态 (viewMode === 'candidateConfirm') - 最小壳 */}
              {viewMode === 'candidateConfirm' && candidateSnapshot && (
                <div className="candidate-confirm-card" data-testid="candidate-confirm-card">
                  <div className="notice-stamp candidate-stamp" aria-hidden="true">
                    <span>待确认</span>
                  </div>
                  <div className="notice-header">
                    <span className="notice-sub">文稿替换确认</span>
                    <h2 className="notice-title">检测到新抓取文章</h2>
                  </div>
                  <blockquote className="notice-verbatim-quote">
                    《{candidateSnapshot.source.title || '无标题文章'}》
                    {candidateSnapshot.source.account ? `（${candidateSnapshot.source.account}）` : ''} 已就绪。
                  </blockquote>
                  <p className="state-placeholder-tip">
                    当前已有正在清洗的会话。候选替换确认交互即将支持（#28）。
                  </p>
                  <div className="notice-actions">
                    <button
                      type="button"
                      className="action-btn action-return"
                      onClick={() => dispatch({ type: 'SET_VIEW_MODE', payload: 'cleaning' })}
                    >
                      返回当前清洗
                    </button>
                  </div>
                </div>
              )}

              {/* 态 3: 损坏记录态 (viewMode === 'corruptedRecord') - 最小壳 */}
              {viewMode === 'corruptedRecord' && (
                <div className="corrupted-record-card" data-testid="corrupted-record-card">
                  <div className="notice-stamp error-stamp" aria-hidden="true">
                    <span>损坏</span>
                  </div>
                  <div className="notice-header">
                    <span className="notice-sub">存储记录异常</span>
                    <h2 className="notice-title">暂时无法恢复上次清洗进度</h2>
                  </div>
                  <blockquote className="notice-verbatim-quote">
                    {corruptedDetails || '检测到无法识别或损坏的清洗会话记录。'}
                  </blockquote>
                  <p className="state-placeholder-tip">
                    原记录已妥善保留未被静默清空。损坏记录备份与恢复流程即将支持（#35）。
                  </p>
                  <div className="notice-actions">
                    <button
                      type="button"
                      className="action-btn action-retry"
                      onClick={() => {
                        sessionSaveQueue.clear();
                        dispatch({ type: 'RESET_TO_EMPTY' });
                      }}
                    >
                      重新开始
                    </button>
                  </div>
                </div>
              )}

              {/* 态 4: 空态 (viewMode === 'empty') */}
              {viewMode === 'empty' && (
                <>
                  {/* 子视图 4.1: 整篇级失败卡片 */}
                  {emptySubState.splitError && (
                    <div className="article-failure-card" data-testid="article-failure-card">
                      <div className="notice-stamp error-stamp" aria-hidden="true">
                        <span>异常</span>
                      </div>
                      <div className="notice-header">
                        <span className="notice-sub">整篇级失败</span>
                        <h2 className="notice-title">无法切分文章正文块</h2>
                      </div>
                      <blockquote className="notice-verbatim-quote">
                        无法从当前页面解析出正文内容（{emptySubState.splitError.message}）。请回到原文看看页面是否完整加载，然后重试。
                      </blockquote>
                      <div className="notice-actions">
                        <button
                          type="button"
                          className="action-btn action-return"
                          onClick={() =>
                            handleReturnToOriginal(
                              emptySubState.splitError?.tabId,
                              emptySubState.splitError?.url
                            )
                          }
                        >
                          回到原文看看
                        </button>
                        <button
                          type="button"
                          className="action-btn action-retry"
                          onClick={() => handleRetry(emptySubState.splitError?.tabId)}
                        >
                          重试
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 子视图 4.2: 审校退单卡片（微信提示页或验证页） */}
                  {!emptySubState.splitError && emptySubState.notice && (
                    <div className="return-notice-card" data-testid="return-notice-card">
                      <div className="notice-stamp" aria-hidden="true">
                        <span>退单</span>
                      </div>
                      <div className="notice-header">
                        <span className="notice-sub">审校退单记录</span>
                        <h2 className="notice-title">
                          {emptySubState.notice.kind === 'captcha'
                            ? '微信需要安全验证'
                            : '微信页面返回提示'}
                        </h2>
                      </div>

                      <blockquote className="notice-verbatim-quote">
                        {emptySubState.notice.kind === 'captcha'
                          ? '微信需要安全验证。请回到原文标签页完成滑块验证后，再点图标重试。WeTrim 不代替你完成验证。'
                          : `“${emptySubState.notice.noticeText}”`}
                      </blockquote>

                      <div className="notice-actions">
                        <button
                          type="button"
                          className="action-btn action-return"
                          onClick={() =>
                            handleReturnToOriginal(
                              emptySubState.notice?.tabId,
                              emptySubState.notice?.kind === 'captcha'
                                ? emptySubState.notice.articleUrl
                                : undefined
                            )
                          }
                        >
                          回到原文看看
                        </button>
                        <button
                          type="button"
                          className="action-btn action-retry"
                          onClick={() => handleRetry(emptySubState.notice?.tabId)}
                        >
                          重试
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 子视图 4.3: 默认空状态 - 3 步指引 */}
                  {!emptySubState.splitError && !emptySubState.notice && (
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
                </>
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
    </AppContext.Provider>
  );
};
