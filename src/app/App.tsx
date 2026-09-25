import React, { useEffect, useReducer, useRef, useState } from 'react';
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
import { CandidateConfirmDialog } from './components/CandidateConfirmDialog';
import { CANDIDATE_COPY } from './copy/candidate';
import { READ_ONLY_COPY } from './copy/read-only';
import { pickWriterContext } from '../shared/app-instance';
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
 * 依据 ARCHITECTURE.md §4.1 ~ §4.5、§7、§8.5，ADR-0005 与 Issue #24、Issue #28：
 * 视觉世界：延续「校对纸/印厂签条」语言 · Operate 模式
 *
 * App 顶层单 useReducer + Context 四态状态机：
 * 1. empty（空态）：3 步指引、微信提示页、验证页、整篇级失败卡片、无文章浮贴夹签
 * 2. cleaning（清洗态）：文章来源与标题位于正文之前，BlockList 连续渲染全部块
 * 3. candidateConfirm（候选确认态）：已有会话时新抓取快照先落盘，弹出换稿通知单确认替换（#28 实现）
 * 4. corruptedRecord（损坏记录态）：存储记录格式损坏或无法识别（#24 留壳，#35 实现）
 */
export const App: React.FC = () => {
  const [state, dispatch] = useReducer(sessionReducer, initialAppState);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const blockListRef = useRef<BlockListHandle>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const savedScrollYRef = useRef<number>(0);
  const savedFocusedBlockIdRef = useRef<string | null>(null);
  const replaceInFlightRef = useRef<boolean>(false);
  const focusTitleAfterReplaceRef = useRef<boolean>(false);
  // 只读实例判定在启动初始化时同步写入，供 pendingCapture 消费等非渲染路径即时读取
  const isReadOnlyRef = useRef<boolean>(false);
  const initDoneRef = useRef<Promise<void> | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 1. marked + DOMPurify 真实渲染三步指引文案
  const stepsMarkdown = `1. **用浏览器打开一篇公众号文章**\\n2. **等它显示完**\\n3. **点工具栏上的 WeTrim 图标** 开始清洗`;
  const renderedStepsHtml = renderMarkdown(stepsMarkdown);

  // 消费 pendingCapture 逻辑：读到后必须立即删除该 key，防止重复消费
  const processCaptureResult = async (res: CaptureResult) => {
    if (res.kind === 'article') {
      dispatch({ type: 'SET_READING_ARTICLE', payload: true });
      try {
        const articleSnapshot = buildArticleSnapshot(res);

        // 先落盘，写入 candidateSnapshot（ARCHITECTURE.md §4.5 与 Issue #28）
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          const candidateRecord: CandidateRecord = {
            schemaVersion: 1,
            snapshot: articleSnapshot,
            savedAt: new Date().toISOString(),
          };
          try {
            await chrome.storage.local.set({ [STORAGE_KEYS.CANDIDATE_SNAPSHOT]: candidateRecord });
          } catch (err: unknown) {
            console.error('[WeTrim] Failed to persist candidateSnapshot:', err);
            // 候选写盘失败：不弹确认；页边夹签提示「新文章没保存下来，当前清洗没有被动过」。该夹签不自动收回，由用户手动关闭
            dispatch({
              type: 'SET_MARGIN_CLIP_NOTE',
              payload: {
                text: CANDIDATE_COPY.candidateSaveFailed,
                autoDismiss: false,
              },
            });
            dispatch({ type: 'SET_READING_ARTICLE', payload: false });
            return;
          }
        }

        // 写入 candidateSnapshot 成功后：
        if (!stateRef.current.session) {
          // 无旧会话：直接提升为当前会话并入队持久化
          const newSession: Session = {
            schemaVersion: 1,
            sessionId: crypto.randomUUID(),
            snapshot: articleSnapshot,
            revision: 1,
            savedAt: new Date().toISOString(),
          };
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            try {
              await chrome.storage.local.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
            } catch {}
          }
          sessionSaveQueue.enqueue(newSession);
          dispatch({ type: 'SET_NEW_SESSION', payload: newSession });
        } else {
          // 已有当前会话：记录当前滚动位置与聚焦块，进入 candidateConfirm
          if (stateRef.current.viewMode !== 'candidateConfirm') {
            savedScrollYRef.current = typeof window !== 'undefined' ? window.scrollY : 0;
            savedFocusedBlockIdRef.current = blockListRef.current?.getFocusedBlockId?.() ?? null;
          }
          setReplaceError(null);
          dispatch({ type: 'SET_ARTICLE_SNAPSHOT', payload: articleSnapshot });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[WeTrim] buildArticleSnapshot error:', err);
        dispatch({
          type: 'SET_SPLIT_ERROR',
          payload: { message: msg, tabId: res.tabId, url: res.source.url },
        });
      } finally {
        dispatch({ type: 'SET_READING_ARTICLE', payload: false });
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
      // 必须等启动初始化判定完是否只读，再决定是否消费
      await initDoneRef.current;
      // 只读实例不写 storage，也不消费 pendingCapture：抓取结果只属于写入方页面（ARCHITECTURE.md §4.6）
      if (isReadOnlyRef.current) return;
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
      const pending = data[STORAGE_KEYS.PENDING_CAPTURE] as { result: CaptureResult } | undefined;
      if (pending && pending.result) {
        // 立即删除该 key
        await chrome.storage.local.remove(STORAGE_KEYS.PENDING_CAPTURE);
        await processCaptureResult(pending.result);
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

        // 检查是否为只读第二实例（ARCHITECTURE.md §4.6 与 Issue #28）
        let isReadOnlyInstance = false;
        try {
          if (chrome.runtime?.getContexts && chrome.tabs?.getCurrent) {
            const appUrl = chrome.runtime.getURL('app.html');
            const contexts = await chrome.runtime.getContexts({
              contextTypes: ['TAB'],
              documentUrls: [appUrl],
            });
            const currentTab = await chrome.tabs.getCurrent();
            const writer = pickWriterContext(contexts ?? []);
            if (writer && currentTab?.id !== undefined && writer.tabId !== currentTab.id) {
              isReadOnlyInstance = true;
            }
          }
        } catch {
          isReadOnlyInstance = false;
        }
        isReadOnlyRef.current = isReadOnlyInstance;

        const data = await chrome.storage.local.get([
          STORAGE_KEYS.CURRENT_SESSION,
          STORAGE_KEYS.CANDIDATE_SNAPSHOT,
        ]);

        const rawSession = data[STORAGE_KEYS.CURRENT_SESSION] as Session | undefined;
        const rawCandidate = data[STORAGE_KEYS.CANDIDATE_SNAPSHOT] as CandidateRecord | undefined;

        // 关页即丢弃候选：启动时发现残留候选应当丢弃。
        // 但只读的第二实例不得删掉写入方页面的候选（见 §4.6 与 Issue #28）。
        if (!isReadOnlyInstance && rawCandidate) {
          try {
            await chrome.storage.local.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
          } catch (err) {
            console.warn('[WeTrim] Error removing stale candidateSnapshot on init:', err);
          }
        }

        let corrupted = false;
        let corruptedDetails = '';

        if (rawSession && (!rawSession.sessionId || !rawSession.snapshot)) {
          corrupted = true;
          corruptedDetails = '存储中的清洗会话记录格式不完整或损坏';
        }

        const initialSession: Session | null = corrupted ? null : (rawSession ?? null);

        if (rawSession && !corrupted) {
          if (!isReadOnlyInstance) {
            sessionSaveQueue.initLoaded(rawSession);
          }
        }

        // 候选永远不会自动提升为当前会话，启动时恢复旧会话
        dispatch({
          type: 'INIT_STORAGE_STATE',
          payload: {
            session: initialSession,
            corrupted,
            corruptedDetails,
            isReadOnly: isReadOnlyInstance,
          },
        });
      } catch (err) {
        console.warn('[WeTrim] Error initializing storage state:', err);
      }
    };

    initDoneRef.current = initStorage();
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

    // 只读实例不写 storage（ARCHITECTURE.md §4.6）
    if (state.isReadOnly) {
      return;
    }

    if (state.session.sessionId !== prev.sessionId) {
      sessionSaveQueue.enqueue(state.session);
      return;
    }

    if (state.session.revision > prev.revision) {
      sessionSaveQueue.enqueue(state.session);
    }
  }, [state.session, state.isReadOnly]);

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
          titleRef,
          dispatch,
          processCaptureResult,
          handleContinueCleaning,
          handleConfirmReplace,
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
  // 依据 Issue #28：候选写盘失败时的提示夹签不自动收回，由用户手动关闭
  useEffect(() => {
    if (state.emptySubState.marginClipNote && state.emptySubState.marginClipNoteAutoDismiss) {
      const timer = setTimeout(() => {
        dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: null });
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [state.emptySubState.marginClipNote, state.emptySubState.marginClipNoteAutoDismiss]);

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

  // 选择继续当前清洗：删除候选、关闭签条，焦点和滚动位置恢复到签条打开之前
  const handleContinueCleaning = async () => {
    // 替换进行中（含 Esc）不接受「继续」，避免两条流程交错
    if (replaceInFlightRef.current) return;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
      } catch (err) {
        console.warn('[WeTrim] Failed to remove candidateSnapshot on continue:', err);
      }
    }
    dispatch({ type: 'DISCARD_CANDIDATE' });
    setReplaceError(null);
    const targetScrollY = savedScrollYRef.current;
    const targetBlockId = savedFocusedBlockIdRef.current;
    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: targetScrollY, behavior: 'instant' });
      }
      if (targetBlockId) {
        blockListRef.current?.restoreFocus(targetBlockId);
      }
    }, 0);
  };

  // 选择替换：先让旧会话尚未完成的保存结束或作废，保证迟到写入不会让旧会话复活；
  // 再写入新会话，成功后删除候选，滚动到顶部，焦点放到标题
  const handleConfirmReplace = async () => {
    // 替换涉及多步异步写入：进行中重复点击直接忽略，避免生成两个新会话
    if (!state.candidateSnapshot || replaceInFlightRef.current) return;
    replaceInFlightRef.current = true;
    setIsReplacing(true);
    try {
      // 1. 等待旧会话在途写入结束或作废
      await sessionSaveQueue.flush();

      const candidateSnapshot = state.candidateSnapshot;
      const newSession: Session = {
        schemaVersion: 1,
        sessionId: crypto.randomUUID(),
        snapshot: candidateSnapshot,
        revision: 1,
        savedAt: new Date().toISOString(),
      };

      // 2. 写入新会话
      try {
        await saveSessionDirect(newSession);
      } catch (err) {
        console.error('[WeTrim] Replace write failed:', err);
        // 替换写入失败：签条保留，旧会话不动；签条内加一行「替换没有完成，当前清洗没有被动过」，并提供重试
        setReplaceError(CANDIDATE_COPY.replaceFailed);
        return;
      }

      // 3. 成功后删除候选
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        try {
          await chrome.storage.local.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
        } catch (err) {
          console.warn('[WeTrim] Failed to remove candidateSnapshot after replace:', err);
        }
      }

      sessionSaveQueue.initLoaded(newSession);
      setReplaceError(null);
      focusTitleAfterReplaceRef.current = true;
      dispatch({
        type: 'SET_NEW_SESSION',
        payload: { session: newSession, saveStatus: 'saved' },
      });
    } finally {
      replaceInFlightRef.current = false;
      setIsReplacing(false);
    }
  };

  // 替换成功后：滚动到顶部，并确保焦点稳固转移至标题（避免原生 dialog 关闭时的默认焦点还原覆盖）
  useEffect(() => {
    if (focusTitleAfterReplaceRef.current && state.viewMode === 'cleaning' && state.session) {
      focusTitleAfterReplaceRef.current = false;
      const timer = setTimeout(() => {
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
        titleRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [state.viewMode, state.session]);

  // 「重试」：通知 background 对目标标签页发起重新抓取探测（必须带明确 tabId）
  const handleRetry = async (tabId?: number) => {
    if (typeof tabId !== 'number') return;
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

  // 只读副本「切换到正在编辑的页面」：按与 service worker 相同的规则现查写入方；
  // 写入方已关闭、当前页成了唯一候选时，重新加载以写入方身份启动
  const handleSwitchToWriter = async () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getContexts || !chrome.tabs) return;
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['TAB'],
        documentUrls: [chrome.runtime.getURL('app.html')],
      });
      const writer = pickWriterContext(contexts ?? []);
      const currentTab = await chrome.tabs.getCurrent();
      if (!writer || writer.tabId === undefined || writer.tabId === currentTab?.id) {
        window.location.reload();
        return;
      }
      await chrome.tabs.update(writer.tabId, { active: true });
      if (writer.windowId !== undefined && chrome.windows) {
        await chrome.windows.update(writer.windowId, { focused: true });
      }
    } catch (err) {
      console.warn('[WeTrim] Failed to switch to writer page:', err);
    }
  };

  const { viewMode, session, candidateSnapshot, corruptedDetails, emptySubState, selfTestPassed, saveStatus, isReadOnly } = state;

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
      ? CANDIDATE_COPY.ticketCandidateTag
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
    isReadOnly
      ? 'var(--ink-secondary)'
      : state.isReadingArticle
      ? 'var(--amber)'
      : viewMode === 'cleaning'
      ? '#07c160'
      : viewMode === 'candidateConfirm'
      ? 'var(--amber)'
      : viewMode === 'corruptedRecord' || emptySubState.splitError
      ? 'var(--vermilion)'
      : emptySubState.notice
      ? 'var(--amber)'
      : 'var(--prussian-blue)';

  const statusText =
    isReadOnly
      ? READ_ONLY_COPY.status
      : state.isReadingArticle
      ? CANDIDATE_COPY.readingArticleStatus
      : viewMode === 'cleaning'
      ? '正在清洗'
      : viewMode === 'candidateConfirm'
      ? CANDIDATE_COPY.waitingConfirmStatus
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
            {/* 保存状态指示位（只读副本不写 storage，也不显示保存状态，见 ARCHITECTURE.md §4.6） */}
            {session && !isReadOnly && (
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
              {/* 只读副本提示（ARCHITECTURE.md §4.6）：位于 inert 区域之外，保证切换按钮可用 */}
              {isReadOnly && (
                <div className="read-only-note" role="status" data-testid="read-only-note">
                  <span className="note-badge">{READ_ONLY_COPY.badge}</span>
                  <span className="read-only-note-text">{READ_ONLY_COPY.note}</span>
                  <button
                    type="button"
                    className="action-btn action-switch-writer"
                    onClick={handleSwitchToWriter}
                    data-testid="read-only-switch-writer"
                  >
                    {READ_ONLY_COPY.btnSwitchToWriter}
                  </button>
                </div>
              )}

              {/* 态 1: 清洗态 或 候选确认态（模态签条压在清洗页之上，旧会话照常渲染在背后并压暗，满足 §8.5「先呈现已有会话」） */}
              {session && (viewMode === 'cleaning' || viewMode === 'candidateConfirm') && (
                <div className="manuscript-slip" data-testid="manuscript-slip" inert={isReadOnly}>
                  {/* 稳定探测超时标注夹签 */}
                  {session.snapshot.captureWarnings?.some(
                    (w) => w.code === 'capture-unstable' || w.code === 'unstable-capture'
                  ) && (
                    <div className="unstable-note" data-testid="unstable-note">
                      <span className="note-badge">批注</span>
                      <span>文章可能还没显示完整，可以回到原文等它加载完再重新抓一次</span>
                    </div>
                  )}

                  {/* 文章来源与标题：必须位于正文内容块之前 */}
                  <div className="slip-header" data-testid="slip-header">
                    <span className="slip-kicker">文稿录入单</span>
                    <h1 className="slip-title" ref={titleRef} tabIndex={-1}>
                      {session.snapshot.source.title || '无标题文章'}
                    </h1>
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

                  {/* 顶部操作行（依据 Issue #28 已移除全页重新抓取按钮） */}
                  <div className="slip-actions">
                    <button
                      type="button"
                      className="action-btn action-return"
                      onClick={() => handleReturnToOriginal(undefined, session.snapshot.source.url)}
                    >
                      回到原文看看
                    </button>
                  </div>

                  {/* 正文块流列表：ADR-0005 唯一渲染入口 */}
                  <BlockList ref={blockListRef} blocks={session.snapshot.blocks} />
                </div>
              )}

              {/* 态 2: 换稿通知单模态签条（压在清洗页之上，原生 <dialog> showModal()） */}
              {viewMode === 'candidateConfirm' && candidateSnapshot && session && !isReadOnly && (
                <CandidateConfirmDialog
                  candidateSnapshot={candidateSnapshot}
                  session={session}
                  replaceError={replaceError}
                  isReplacing={isReplacing}
                  onContinue={handleContinueCleaning}
                  onReplace={handleConfirmReplace}
                  onReturnToOriginal={() =>
                    handleReturnToOriginal(undefined, candidateSnapshot.source.url)
                  }
                />
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
