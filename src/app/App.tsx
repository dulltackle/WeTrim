import { SavePanel } from './feishu/SavePanel';
import { flushSync } from 'react-dom';
import { queryWriter, setWriterEnabled, withWriterAccess, writerStorage } from './state/writer-access';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CaptureResult, CandidateRecord, Session, ArticleSnapshot } from '../shared/types';
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
import {
  BlockList,
  BLOCK_LIST_PANEL_ID,
  type BlockListHandle,
  type BlockFilterMode,
} from './components/BlockList';
import { CandidateConfirmDialog } from './components/CandidateConfirmDialog';
import { UnlocalizedImagesDialog } from './components/UnlocalizedImagesDialog';
import type { ImageDecision, ImageEditTarget, UnlocalizedImage } from './export/unlocalized-images';
import { PreviewDialog } from './components/PreviewDialog';
import { ExportFeedbackDialog, type ExportFeedback } from './components/ExportFeedbackDialog';
import { CANDIDATE_COPY } from './copy/candidate';
import { READ_ONLY_COPY } from './copy/read-only';
import { NAVIGATION_COPY } from './copy/navigation';
import { PREVIEW_COPY } from './copy/preview';
import { EXPORT_COPY } from './copy/export';
import { WORKBENCH_COPY } from './copy/workbench';
import { EMPTY_SEARCH_STATE, type SearchState } from './search/text-search';
import { renderMarkdown } from './preview/render';
import {
  exportArticleWithPicker,
  writeArticleDirectory,
  type ExportArticleResult,
  type ExportArticleOptions,
} from './export/write-directory';
import { sanitizeArticleTitle } from './export/sanitize-filename';
import {
  collectExportImageReferences,
  formatImageBaseName,
} from './export/collect-images';
import {
  detectImageFormat,
  fetchImageResource,
  fetchAllExportImages,
  type FetchProgress,
} from './export/fetch-images';
import { rewriteMarkdownImagePaths } from './export/rewrite-markdown';
import {
  buildMarkdown,
  buildResultFile,
  buildFrontMatter,
  stripBoundaryEmptyLines,
  parseFrontMatterDate,
  type ResultFile,
} from './export/build-markdown';
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
  restoreSession,
  saveSessionDirect,
  clearSessionDirect,
} from './state/persistence';
import './app.css';
import { RecoveryPanel } from './components/RecoveryPanel';
import { CloseIcon } from './components/CloseIcon';

const SAVE_STATUS_COPY = WORKBENCH_COPY.saveStatus;
const FILTER_TAB_ORDER: BlockFilterMode[] = ['all', 'included', 'excluded'];

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
  const isReadOnlyRef = useRef<boolean>(true);
  const [instanceMode, setInstanceMode] = useState<'checking' | 'readonly' | 'error' | 'restoring' | 'writer'>('checking');
  const instanceModeRef = useRef(instanceMode);
  const arbitrationBusyRef = useRef(false);
  const [switchError, setSwitchError] = useState('');
  const [draft, setDraft] = useState<Session | null>(null);
  const draftRef = useRef<Session | null>(null);
  const instanceTitleRef = useRef<HTMLHeadingElement>(null);
  const recoveryBlockedRef = useRef(true);
  const captureCutoffRef = useRef<number | null>(null);
  const recoveryInFlightRef = useRef(false);
  const captureInFlightRef = useRef(false);
  const captureQueuedRef = useRef(false);
  const focusEmptyRef = useRef<HTMLHeadingElement>(null);
  const focusEmptyAfterClearRef = useRef(false);
  const initDoneRef = useRef<Promise<void> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Issue #29: 搜索、序号定位与顶栏联动状态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>(EMPTY_SEARCH_STATE);
  const [orderInputValue, setOrderInputValue] = useState('');
  const [orderJumpTip, setOrderJumpTip] = useState<{
    text: string;
    canSwitchToAll?: boolean;
    targetOrder?: number;
  } | null>(null);
  const [currentFilter, setCurrentFilter] = useState<BlockFilterMode>('all');
  const [wrappedToast, setWrappedToast] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const wrappedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const filterTabRefs = useRef<Partial<Record<BlockFilterMode, HTMLButtonElement | null>>>({});

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const previewBtnRef = useRef<HTMLButtonElement>(null);
  const isPreviewOpenRef = useRef(isPreviewOpen);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  // 同一时刻只允许一次导出，避免重复触发时两次写入争抢同一目录名
  const exportInFlightRef = useRef(false);
  const [unlocalizedImages, setUnlocalizedImages] = useState<UnlocalizedImage[] | null>(null);
  const imageDecisionRef = useRef<((decision: ImageDecision) => void) | null>(null);
  const [imageEditTarget, setImageEditTarget] = useState<ImageEditTarget | null>(null);
  const decideImages = (decision: ImageDecision) => {
    const resolve = imageDecisionRef.current;
    imageDecisionRef.current = null;
    setUnlocalizedImages(null);
    resolve?.(decision);
  };
  // 等两层原生对话框都卸载后，再让块流打开编辑器，避免焦点被模态归还覆盖。
  useEffect(() => {
    if (imageEditTarget && !unlocalizedImages && !isPreviewOpen) {
      blockListRef.current?.editImageReference(imageEditTarget);
      setImageEditTarget(null);
    }
  }, [imageEditTarget, unlocalizedImages, isPreviewOpen]);
  useEffect(() => () => imageDecisionRef.current?.('cancel'), []);

  // 导出期间的图片下载进度（Issue #33：按实际接收字节反馈，不按张数估算）
  const [exportProgress, setExportProgress] = useState<FetchProgress | null>(null);
  // 顶栏导出请求计数：flush 防抖编辑后要等新快照提交，再在 effect 里用最新内容导出
  const [toolbarExportRequest, setToolbarExportRequest] = useState(0);
  // 预览关闭后要执行的焦点/定位动作：模态 <dialog> 打开期间背后清洗页是 inert 的，
  // 聚焦必须等对话框真正关闭（提交后）再做，否则 focus() 无效且会被对话框的焦点归还覆盖
  const afterPreviewCloseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isPreviewOpenRef.current = isPreviewOpen;
    if (!isPreviewOpen && afterPreviewCloseRef.current) {
      const action = afterPreviewCloseRef.current;
      afterPreviewCloseRef.current = null;
      const timer = setTimeout(action, 0);
      return () => clearTimeout(timer);
    }
  }, [isPreviewOpen]);

  // 固定顶栏实际高度（工具行折行、窄屏纵向排列、提示出现时会变高）通过滚动容器的 scroll-padding-top 下发，
  // 供 scrollIntoView 使用；不让可继承变量变化触发整篇样式重算。
  const isStickyHeader = state.viewMode === 'cleaning';
  useEffect(() => {
    const header = headerRef.current;
    const rootStyle = document.documentElement.style;
    if (!isStickyHeader || !header || typeof ResizeObserver === 'undefined') {
      rootStyle.removeProperty('scroll-padding-top');
      return;
    }
    const STICKY_HEADER_GAP = 12; // 与 .workbench-header.is-sticky 的 margin-bottom 一致
    const syncOffset = () => {
      const offset = `${header.offsetHeight + STICKY_HEADER_GAP}px`;
      if (rootStyle.scrollPaddingTop !== offset) rootStyle.scrollPaddingTop = offset;
    };
    syncOffset();
    const observer = new ResizeObserver(syncOffset);
    observer.observe(header);
    return () => {
      observer.disconnect();
      rootStyle.removeProperty('scroll-padding-top');
    };
  }, [isStickyHeader]);

  // BlockList 在筛选视图变空时，把焦点交回当前筛选页签
  const handleFilterFocusFallback = useCallback((filter: BlockFilterMode) => {
    filterTabRefs.current[filter]?.focus();
  }, []);

  // 快捷键支持（Issue #29 §6）：
  // 第一次按 Ctrl/⌘+F，焦点进入搜索框并全选里面的文字；焦点已经在搜索框时再按一次，交给浏览器原生查找
  useEffect(() => {
    if (state.viewMode !== 'cleaning' || state.isReadOnly) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isReadOnlyRef.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (document.activeElement === searchInputRef.current) {
          // 焦点已经在搜索框时再按一次，交给浏览器原生查找
          return;
        }
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.viewMode, state.isReadOnly]);

  // 搜索输入改变
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    // 搜索状态经 BlockList 的 onSearchStateChange 回写
    blockListRef.current?.search(q);
  };

  // 清空搜索
  const handleClearSearch = () => {
    setSearchQuery('');
    blockListRef.current?.clearSearch();
    setWrappedToast(false);
    searchInputRef.current?.focus();
  };

  const triggerWrappedToast = () => {
    setWrappedToast(true);
    if (wrappedTimerRef.current) clearTimeout(wrappedTimerRef.current);
    wrappedTimerRef.current = setTimeout(() => {
      setWrappedToast(false);
    }, 2500);
  };

  // 下一处命中
  const handleNextHit = () => {
    const res = blockListRef.current?.gotoNextHit();
    if (res?.wrapped) {
      triggerWrappedToast();
    }
  };

  // 上一处命中
  const handlePrevHit = () => {
    const res = blockListRef.current?.gotoPrevHit();
    if (res?.wrapped) {
      triggerWrappedToast();
    }
  };

  // 搜索框按键
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrevHit();
      } else {
        handleNextHit();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Esc 把焦点还给当前命中所在的块，查询词和高亮保留；点 × 才清空
      blockListRef.current?.focusCurrentHitBlock();
    }
  };

  // 序号定位
  const handleOrderJump = () => {
    const trimmed = orderInputValue.trim();
    const n = parseInt(trimmed, 10);
    const totalBlocks = state.session?.snapshot.blocks.length || 0;
    const res = blockListRef.current?.locateOrder(n);
    if (!res || res.status === 'out_of_range') {
      setOrderJumpTip({
        text: NAVIGATION_COPY.totalBlocksOutOfRange(totalBlocks),
        canSwitchToAll: false,
      });
    } else if (res.status === 'hidden_by_filter') {
      const text =
        res.hiddenInFilter === 'excluded'
          ? NAVIGATION_COPY.targetBlockExcluded(n)
          : NAVIGATION_COPY.targetBlockIncluded(n);
      setOrderJumpTip({
        text,
        canSwitchToAll: true,
        targetOrder: n,
      });
    } else if (res.status === 'success') {
      setOrderJumpTip(null);
    }
  };

  // 切到全部并跳过去
  const handleSwitchToAllAndJump = () => {
    if (orderJumpTip?.targetOrder) {
      // 由 BlockList 在「全部」下的块挂载完成后再定位，不依赖定时器猜测渲染时机
      blockListRef.current?.setFilter('all', { thenLocateOrder: orderJumpTip.targetOrder });
      setOrderJumpTip(null);
    }
  };

  // 序号输入框按键
  const handleOrderKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleOrderJump();
    } else if (e.key === 'Escape') {
      setOrderJumpTip(null);
    }
  };

  // 筛选 Tab 点击
  const handleFilterTabClick = (nextFilter: BlockFilterMode) => {
    // currentFilter 经 BlockList 的 onFilterChange 回写
    blockListRef.current?.setFilter(nextFilter);
    setOrderJumpTip(null);
  };

  // 筛选页签的方向键 / Home / End：移动焦点并立即切换（筛选切换实测远低于 100 ms 预算）
  const handleFilterTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const idx = FILTER_TAB_ORDER.indexOf(currentFilter);
    let next: BlockFilterMode | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = FILTER_TAB_ORDER[(idx + 1) % FILTER_TAB_ORDER.length];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = FILTER_TAB_ORDER[(idx - 1 + FILTER_TAB_ORDER.length) % FILTER_TAB_ORDER.length];
    } else if (e.key === 'Home') {
      next = FILTER_TAB_ORDER[0];
    } else if (e.key === 'End') {
      next = FILTER_TAB_ORDER[FILTER_TAB_ORDER.length - 1];
    }
    if (!next) return;
    e.preventDefault();
    handleFilterTabClick(next);
    filterTabRefs.current[next]?.focus();
  };

  // Issue #31: 检查结果汇总预览操作处理
  const handleOpenPreview = () => {
    if (typeof window !== 'undefined') {
      savedScrollYRef.current = window.scrollY;
    }
    // 先让编辑器里防抖中的修改落入快照（与 setIsPreviewOpen 同批提交），预览才是当前内存内容
    blockListRef.current?.flushPendingEdits();
    setIsPreviewOpen(true);
  };

  const closePreviewThen = (action: () => void) => {
    afterPreviewCloseRef.current = action;
    setIsPreviewOpen(false);
  };

  const handleClosePreview = () => {
    closePreviewThen(() => {
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: savedScrollYRef.current, behavior: 'instant' });
      }
      previewBtnRef.current?.focus({ preventScroll: true });
    });
  };

  // 降级条目与「跳到第一个空块」共用：关闭后定位并聚焦原块，当前筛选下看不到时先切到「全部」
  const handleJumpToBlockFromPreview = (order: number, id: string) => {
    const targetBlock = state.session?.snapshot.blocks.find((b) => b.id === id);
    const isVisible =
      currentFilter === 'all' ||
      (currentFilter === 'included' && targetBlock?.included) ||
      (currentFilter === 'excluded' && !targetBlock?.included);

    closePreviewThen(() => {
      if (!isVisible) {
        blockListRef.current?.setFilter('all', { thenLocateOrder: order });
      } else {
        blockListRef.current?.focusBlock(id);
      }
    });
  };

  const handleRecoverExcludedFromPreview = () => {
    // 全部块都被剔除：切到「剔除」筛选
    closePreviewThen(() => {
      blockListRef.current?.setFilter('excluded');
    });
  };

  // Issue #32 & Issue #33: 导出 Markdown 与目录写入操作处理
  const performExport = async (
    targetSnapshot: ArticleSnapshot,
    targetResultFile?: ResultFile,
    options?: ExportArticleOptions
  ): Promise<ExportArticleResult> => {
    if (exportInFlightRef.current) {
      return { ok: false, busy: true, message: WORKBENCH_COPY.exportBusy };
    }
    exportInFlightRef.current = true;
    let res: ExportArticleResult;
    try {
      res = await exportArticleWithPicker(targetSnapshot, {
        resultFile: targetResultFile,
        showDirectoryPicker: options?.showDirectoryPicker,
        parentHandle: options?.parentHandle,
        onProgress: (progress) => {
          setExportProgress(progress);
          options?.onProgress?.(progress);
        },
        fetchFn: options?.fetchFn,
        hasPermission: options?.hasPermission,
        onUnlocalized: options?.onUnlocalized ?? (images => new Promise<ImageDecision>(resolve => {
          setExportProgress(null);
          imageDecisionRef.current = resolve;
          setUnlocalizedImages(images);
        })),
      });
    } finally {
      exportInFlightRef.current = false;
      setExportProgress(null);
    }

    if (res.ok) {
      setExportFeedback({
        isOpen: true,
        type: 'success',
        title: res.failedImagesCount ? EXPORT_COPY.exportExternalTitle(res.failedImagesCount) : EXPORT_COPY.exportSuccessTitle,
        desc: EXPORT_COPY.exportSuccessDesc(res.articleDirName, res.markdownFileName, {
          localized: res.localizedImagesCount ?? 0,
          failed: res.failedImagesCount ?? 0,
        }),
      });
      // 验收标准：导出成功不能把未保存状态改成已保存
      // 保持现有的 sessionSaveQueue 和 state.saveState 完全不变
      return res;
    }
    if (res.aborted) {
      // 用户取消目录选择不是错误，静默返回
      return res;
    }
    if (res.emptyBody) {
      setExportFeedback({
        isOpen: true,
        type: 'empty',
        title: EXPORT_COPY.emptyBodyTitle,
        desc: EXPORT_COPY.emptyBodyDesc,
      });
      return res;
    }
    const errorDetail = res.error?.message || res.message;
    if (res.stage === 'pick') {
      // 目录选择本身失败：还没写入任何东西，不提残留与磁盘空间
      setExportFeedback({
        isOpen: true,
        type: 'error',
        title: EXPORT_COPY.pickFailedTitle,
        desc: EXPORT_COPY.pickFailedDesc(errorDetail),
      });
      return res;
    }
    // 磁盘或权限导致写入失败时明确报告未完成；只有本次确实建了目录才提示可能残留
    setExportFeedback({
      isOpen: true,
      type: 'error',
      title: EXPORT_COPY.exportFailedTitle,
      desc: EXPORT_COPY.exportFailedDesc(res.attemptedDirName, errorDetail),
    });
    return res;
  };

  const exportProgressText = exportProgress
    ? EXPORT_COPY.exportProgress(
        exportProgress.completedCount,
        exportProgress.totalCount,
        exportProgress.downloadedBytes
      )
    : null;

  const handleToolbarExport = () => {
    if (!state.session || exportInFlightRef.current) return;
    // 从一次固定的当前内容生成本次产物：先让编辑器里防抖中的修改落入快照。
    // flush 只是派发更新，新快照要到下次提交才可见，所以与导出请求同批提交，在 effect 里读取
    blockListRef.current?.flushPendingEdits();
    setToolbarExportRequest((n) => n + 1);
  };

  // 只响应新的导出请求；state 取本次提交（已含 flush 后的编辑）的值
  useEffect(() => {
    if (toolbarExportRequest === 0) return;
    const snapshot = state.session?.snapshot;
    if (!snapshot) return;
    void performExport(snapshot);
  }, [toolbarExportRequest]);

  const handlePreviewExport = async (frozenSnapshot: ArticleSnapshot, frozenResultFile: ResultFile) => {
    await performExport(frozenSnapshot, frozenResultFile);
  };

  // 1. marked + DOMPurify 真实渲染三步指引文案
  const renderedStepsHtml = useMemo(() => renderMarkdown(WORKBENCH_COPY.emptyStepsMarkdown), []);

  // 消费 pendingCapture 逻辑：读到后必须立即删除该 key，防止重复消费
  const processCaptureResult = async (res: CaptureResult) => {
    if (isReadOnlyRef.current) return;
    if (recoveryBlockedRef.current) {
      dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: { text: '请先处理上次进度', autoDismiss: false } });
      return;
    }
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
            await writerStorage.set({ [STORAGE_KEYS.CANDIDATE_SNAPSHOT]: candidateRecord });
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

        if (isReadOnlyRef.current) return;
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
              await writerStorage.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
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
        payload: WORKBENCH_COPY.noArticleClipNote,
      });
    }
  };

  const checkPendingCapture = async () => {
    if (captureInFlightRef.current) { captureQueuedRef.current = true; return; }
    captureInFlightRef.current = true;
    try {
      // 必须等启动初始化判定完是否只读，再决定是否消费
      await initDoneRef.current;
      // 只读实例不写 storage，也不消费 pendingCapture：抓取结果只属于写入方页面（ARCHITECTURE.md §4.6）
      if (isReadOnlyRef.current) return;
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const blockedWhenReceived = recoveryBlockedRef.current;
      const pending = await withWriterAccess(async () => {
        const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_CAPTURE);
        const value = data[STORAGE_KEYS.PENDING_CAPTURE] as { result: CaptureResult; capturedAt?: string } | undefined;
        if (value?.result) await chrome.storage.local.remove(STORAGE_KEYS.PENDING_CAPTURE);
        return value;
      });
      if (pending && pending.result) {
        // 清除期间产生、但延后才通知/读到的抓取也不得进入空会话分支。
        const capturedAt = Date.parse(pending.capturedAt ?? '');
        const predatesClear = captureCutoffRef.current !== null &&
          (!Number.isFinite(capturedAt) || capturedAt <= captureCutoffRef.current);
        if (blockedWhenReceived || predatesClear) {
          dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: {
            text: predatesClear ? '上次进度已清除，请回到文章页重新发起' : '请先处理上次进度', autoDismiss: false,
          } });
        } else {
          await processCaptureResult(pending.result);
        }
      }
    } catch (err) {
      console.warn('[WeTrim] Error reading pendingCapture:', err);
    } finally {
      captureInFlightRef.current = false;
      if (captureQueuedRef.current) {
        captureQueuedRef.current = false;
        void checkPendingCapture();
      }
    }
  };

  const recoverProgress = async () => {
    if (recoveryInFlightRef.current) return;
    recoveryInFlightRef.current = true;
    recoveryBlockedRef.current = true;
    dispatch({ type: 'SET_RECOVERY', payload: { kind: 'loading' } });
    try {
      const result = await withWriterAccess(() => restoreSession());
      if (result.kind === 'readError' || result.kind === 'unrecognized') {
        dispatch({ type: 'SET_RECOVERY', payload: result });
        return;
      }
      // 候选不会在重开或重试时自动提升；只读副本不做任何存储写入。
      if (!isReadOnlyRef.current && typeof chrome !== 'undefined' && chrome.storage?.local) {
        try { await writerStorage.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT); } catch {}
      }
      if (isReadOnlyRef.current) return;
      const session = result.kind === 'ready' ? result.session : null;
      if (session && !isReadOnlyRef.current) sessionSaveQueue.initLoaded(session);
      if (session) focusTitleAfterReplaceRef.current = true;
      else focusEmptyAfterClearRef.current = true;
      dispatch({ type: 'INIT_STORAGE_STATE', payload: {
        session, corrupted: false, isReadOnly: isReadOnlyRef.current,
      } });
      // 在异步抓取处理返回前同步更新引用，避免 React 尚未提交时误走空会话分支。
      stateRef.current = sessionReducer(stateRef.current, { type: 'INIT_STORAGE_STATE', payload: {
        session, corrupted: false, isReadOnly: isReadOnlyRef.current,
      } });
      recoveryBlockedRef.current = false;
    } catch {
      // 恢复重试中的资格检查也可能失败，保留记录并提供可重试的实例错误态。
      setWriterEnabled(false);
      isReadOnlyRef.current = true;
      instanceModeRef.current = 'error';
      setInstanceMode('error');
      throw new Error('暂时无法确认编辑页面');
    } finally {
      recoveryInFlightRef.current = false;
    }
  };

  const clearRecovery = async () => {
    if (isReadOnlyRef.current || !recoveryBlockedRef.current) return;
    // 等在途写入结束后，一次删除会话与待处理抓取；失败不先删掉原会话。
    await sessionSaveQueue.clear(true);
    captureCutoffRef.current = Date.now();
    focusEmptyAfterClearRef.current = true;
    dispatch({ type: 'RESET_TO_EMPTY' });
    stateRef.current = sessionReducer(stateRef.current, { type: 'RESET_TO_EMPTY' });
    recoveryBlockedRef.current = false;
  };

  useEffect(() => {
    if (focusEmptyAfterClearRef.current && state.viewMode === 'empty') {
      focusEmptyAfterClearRef.current = false;
      focusEmptyRef.current?.focus();
    }
  }, [state.viewMode]);

  const changeInstanceMode = (mode: typeof instanceMode) => {
    instanceModeRef.current = mode;
    setInstanceMode(mode);
  };

  const stopWriting = async () => {
    setWriterEnabled(false);
    isReadOnlyRef.current = true;
    // 先收回存储资格，再把输入框防抖中的文字收进内存副本。
    flushSync(() => blockListRef.current?.flushPendingEdits());
    const current = stateRef.current.session;
    if (current && (sessionSaveQueue.getStatus() !== 'saved' ||
      current.revision > sessionSaveQueue.getLastSavedRevision())) {
      draftRef.current = current;
      setDraft(current);
    }
    setIsPreviewOpen(false);
    decideImages('cancel');
    setExportFeedback(null);
    await sessionSaveQueue.suspend();
  };

  const arbitrate = async () => {
    if (arbitrationBusyRef.current) return;
    arbitrationBusyRef.current = true;
    try {
      const { isWriter } = await queryWriter();
      if (!isWriter) {
        if (!isReadOnlyRef.current) await stopWriting();
        changeInstanceMode('readonly');
        return;
      }
      if (instanceModeRef.current === 'writer' || draftRef.current) return;
      const takingOver = instanceModeRef.current !== 'checking';
      changeInstanceMode('restoring');
      await sessionSaveQueue.suspend();
      setWriterEnabled(true);
      isReadOnlyRef.current = false;
      prevSessionRef.current = null;
      await recoverProgress();
      changeInstanceMode('writer');
      if (takingOver && !recoveryBlockedRef.current) {
        dispatch({ type: 'SET_MARGIN_CLIP_NOTE', payload: { text: '已在此页面继续编辑', autoDismiss: true } });
      }
    } catch {
      await stopWriting();
      changeInstanceMode('error');
    } finally {
      arbitrationBusyRef.current = false;
    }
  };

  useEffect(() => {
    if (!initDoneRef.current) initDoneRef.current = arbitrate();
    void checkPendingCapture();
    const recheck = () => {
      // 检查失败后等待用户重试，不以定时器掩盖错误。
      if (instanceModeRef.current === 'error' || arbitrationBusyRef.current) return;
      const previousMode = instanceModeRef.current;
      initDoneRef.current = arbitrate();
      if (previousMode !== 'writer') void checkPendingCapture();
    };
    const timer = window.setInterval(recheck, 1000);
    const messageListener = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === PENDING_CAPTURE_MESSAGE_TYPE) { recheck(); void checkPendingCapture(); }
    };
    if (typeof chrome === 'undefined') return () => clearInterval(timer);
    chrome.runtime?.onMessage?.addListener(messageListener);
    chrome.tabs?.onRemoved?.addListener(recheck);
    chrome.tabs?.onCreated?.addListener(recheck);
    window.addEventListener('focus', recheck);
    return () => {
      clearInterval(timer);
      chrome.runtime?.onMessage?.removeListener(messageListener);
      chrome.tabs?.onRemoved?.removeListener(recheck);
      chrome.tabs?.onCreated?.removeListener(recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);

  useEffect(() => {
    if (instanceMode === 'writer') {
      (titleRef.current ?? focusEmptyRef.current)?.focus();
    } else instanceTitleRef.current?.focus();
  }, [instanceMode]);

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
    if (isReadOnlyRef.current) {
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
          buildResultFile,
          buildFrontMatter,
          parseFrontMatterDate,
          stripBoundaryEmptyLines,
          splitBlocks,
          blockListRef,
          titleRef,
          searchInputRef,
          dispatch,
          processCaptureResult,
          handleContinueCleaning,
          handleConfirmReplace,
          sessionSaveQueue,
          SessionSaveQueue,
          loadSession,
          saveSessionDirect,
          clearSessionDirect,
          handleSearchChange,
          handleClearSearch,
          handleNextHit,
          handlePrevHit,
          handleOrderJump,
          handleFilterTabClick,
          handleOpenPreview,
          handleClosePreview,
          getIsPreviewOpen: () => isPreviewOpenRef.current,
          sanitizeArticleTitle,
          writeArticleDirectory,
          exportArticleWithPicker,
          collectExportImageReferences,
          formatImageBaseName,
          detectImageFormat,
          fetchImageResource,
          fetchAllExportImages,
          rewriteMarkdownImagePaths,
          performExport,
          handleToolbarExport,
          exportBtnRef,
          setSearchQuery,
          setOrderInputValue,
          getState: () => stateRef.current,
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
    if (isReadOnlyRef.current || replaceInFlightRef.current) return;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await writerStorage.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
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
    if (isReadOnlyRef.current || !state.candidateSnapshot || replaceInFlightRef.current) return;
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
          await writerStorage.remove(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
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
        if (!isReadOnlyRef.current) titleRef.current?.focus();
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
    setSwitchError('');
    try {
      const { writer, isWriter } = await queryWriter();
      if (isWriter) { await arbitrate(); return; }
      if (!writer) throw new Error('未找到编辑页面');
      await chrome.tabs.update(writer.tabId, { active: true });
      if (writer.windowId !== undefined) await chrome.windows.update(writer.windowId, { focused: true });
    } catch {
      await arbitrate();
      setSwitchError('切换未完成，请重试。');
    }
  };

  const { viewMode, session, candidateSnapshot, emptySubState, selfTestPassed, saveStatus, isReadOnly } = state;

  const saveStatusText = saveStatus === 'error' ? '' : SAVE_STATUS_COPY[saveStatus];

  // 顶部工作台状态计算
  const ticketTag =
    viewMode === 'cleaning'
      ? WORKBENCH_COPY.ticketTags.cleaning
      : viewMode === 'candidateConfirm'
      ? CANDIDATE_COPY.ticketCandidateTag
      : viewMode === 'corruptedRecord'
      ? '恢复'
      : emptySubState.notice
      ? WORKBENCH_COPY.ticketTags.notice
      : emptySubState.splitError
      ? WORKBENCH_COPY.ticketTags.splitError
      : WORKBENCH_COPY.ticketTags.empty;

  // 票号只显示真实信息：品牌名加当前文章标题（按完整字素截断，不切断 emoji），没有文章时只显示品牌名
  const ticketTitle = session?.snapshot.source.title || candidateSnapshot?.source.title || '';
  const ticketNumber = ticketTitle
    ? `${WORKBENCH_COPY.ticketBrand} · ${truncateGraphemes(ticketTitle, 16, '…')}`
    : WORKBENCH_COPY.ticketBrand;

  const statusDotTone =
    isReadOnly
      ? 'muted'
      : state.isReadingArticle
      ? 'pending'
      : viewMode === 'cleaning'
      ? 'ok'
      : viewMode === 'candidateConfirm'
      ? 'pending'
      : viewMode === 'corruptedRecord' || emptySubState.splitError
      ? 'error'
      : emptySubState.notice
      ? 'pending'
      : 'idle';

  const includedBlockCount = session ? session.snapshot.blocks.filter((b) => b.included).length : 0;

  const statusText =
    isReadOnly
      ? READ_ONLY_COPY.status
      : state.isReadingArticle
      ? CANDIDATE_COPY.readingArticleStatus
      : viewMode === 'cleaning'
      ? WORKBENCH_COPY.systemStatus.cleaning
      : viewMode === 'candidateConfirm'
      ? CANDIDATE_COPY.waitingConfirmStatus
      : viewMode === 'corruptedRecord'
      ? (state.recovery?.kind === 'loading' ? '正在读取进度' : '等待处理上次进度')
      : emptySubState.splitError
      ? WORKBENCH_COPY.systemStatus.splitError
      : emptySubState.notice
      ? WORKBENCH_COPY.systemStatus.notice
      : WORKBENCH_COPY.systemStatus.ready;

  const contextValue = useMemo(() => ({ state, dispatch }), [state, dispatch]);

  if (instanceMode !== 'writer' || draft) {
    const failed = instanceMode === 'error';
    const readonly = instanceMode === 'readonly';
    return <div className="app-container" data-instance-mode={instanceMode}
      data-csp-eval-verified={state.selfTestPassed ? 'true' : 'false'}>
      <header className="workbench-header"><div className="header-primary-row">
        <span className="ticket-tag">WeTrim</span><span>{readonly ? READ_ONLY_COPY.badge : '检查编辑页面'}</span>
      </div></header>
      <main className="proof-sheet instance-sheet">
        <section className="instance-notice" data-testid={readonly ? 'read-only-note' : 'instance-notice'}
          data-recovery-kind={instanceMode === 'restoring' ? 'loading' : undefined}>
          <h1 ref={instanceTitleRef} tabIndex={-1}>{failed ? '暂时无法确认编辑页面' : readonly ?
            '另一页面正在编辑' : instanceMode === 'restoring' ? '正在恢复上次进度…' : '正在检查编辑页面…'}</h1>
          <p role="status">{failed ? '请重试，确认后才能继续编辑。' : readonly ? READ_ONLY_COPY.note : '请稍候。'}</p>
          {readonly && <button className="action-btn" onClick={handleSwitchToWriter}
            data-testid="read-only-switch-writer">{READ_ONLY_COPY.btnSwitchToWriter}</button>}
          {failed && <button className="action-btn" onClick={() => void arbitrate()}>重试</button>}
          {switchError && <p role="alert">{switchError}</p>}
          {draft && <div className="instance-draft" role="alert">
            <p>编辑资格已变化，未保存修改仍保留在此页。请先下载副本；继续时将读取最后成功保存的进度，副本目前不能导入。</p>
            <button className="action-btn" onClick={() => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
              const anchor = document.createElement('a'); anchor.href = url;
              anchor.download = 'WeTrim-未保存修改.json'; anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 60_000);
            }}>下载未保存副本</button>
            <button className="action-btn" onClick={() => {
              draftRef.current = null; setDraft(null); void arbitrate();
            }}>放弃此页未保存修改并继续</button>
          </div>}
        </section>
      </main>
    </div>;
  }

  return (
    <AppContext.Provider value={contextValue}>
      <div
        className="app-container"
        data-csp-eval-verified={selfTestPassed ? 'true' : 'false'}
        data-view-mode={viewMode}
      >
        {/* 顶部工作台状态条（清洗态下固定在顶部，提供搜索、定位与筛选工具，Issue #29） */}
        <header
          ref={headerRef}
          className={`workbench-header ${viewMode === 'cleaning' ? 'is-sticky' : ''}`}
          data-testid="workbench-header"
        >
          <div className="header-primary-row" data-testid="header-primary-row">
            <div className="ticket-slug">
              <span className="ticket-tag">{ticketTag}</span>
              <span className="ticket-number">{ticketNumber}</span>
            </div>
            <div className="header-status-group" data-testid="header-status-group">
              {/* 保存状态指示位（只读副本不写 storage，也不显示保存状态，见 ARCHITECTURE.md §4.6） */}
              {session && !isReadOnly && (
                // 播报区与可操作按钮分开：role="status" 会覆盖 <button> 的原生角色
                <div className="save-status-region" role="status" aria-live="polite">
                  {saveStatus === 'error' ? (
                    <button
                      type="button"
                      className="save-status save-status-error"
                      data-testid="save-status"
                      data-save-status="error"
                      onClick={handleRetrySave}
                      title={SAVE_STATUS_COPY.retryTitle}
                    >
                      <span className="save-status-dot save-status-dot-error" aria-hidden="true"></span>
                      <span className="save-status-text">{SAVE_STATUS_COPY.error}</span>
                    </button>
                  ) : (
                    <div
                      className={`save-status save-status-${saveStatus}`}
                      data-testid="save-status"
                      data-save-status={saveStatus}
                    >
                      <span
                        className={`save-status-dot save-status-dot-${saveStatus}`}
                        aria-hidden="true"
                      ></span>
                      <span className="save-status-text">{saveStatusText}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="system-status" data-testid="system-status">
                <span className={`status-dot status-dot-${statusDotTone}`} aria-hidden="true"></span>
                <span>{statusText}</span>
              </div>
            </div>
          </div>

          {/* 清洗态工具行：仅在 cleaning 态渲染，只读页隐藏整行（Issue #29 §4） */}
          {session && viewMode === 'cleaning' && !isReadOnly && (
            <>
            <nav
              className="header-nav-toolbar"
              data-testid="header-nav-toolbar"
              aria-label={WORKBENCH_COPY.navAriaLabel}
            >
              <div className="nav-toolbar-main">
                {/* 搜索框 */}
                <div className="search-box" data-testid="search-box">
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="search-input"
                    data-testid="search-input"
                    placeholder={NAVIGATION_COPY.searchPlaceholder}
                    aria-label={NAVIGATION_COPY.searchAriaLabel}
                    value={searchQuery}
                    onChange={handleSearchChange}
                    onKeyDown={handleSearchKeyDown}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="search-clear-btn"
                      data-testid="search-clear-btn"
                      aria-label={NAVIGATION_COPY.clearSearchAriaLabel}
                      title={NAVIGATION_COPY.clearSearch}
                      onClick={handleClearSearch}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>

                {/* 命中计数与上一处/下一处 */}
                {searchQuery.trim() !== '' && (
                  <div className="search-nav-group" data-testid="search-nav-group">
                    <span
                      className="search-counter"
                      data-testid="search-counter"
                      role="status"
                      aria-live="polite"
                      aria-label={NAVIGATION_COPY.hitCountAria(
                        searchState.totalHits > 0 ? searchState.currentHitIndex + 1 : 0,
                        searchState.totalHits
                      )}
                    >
                      {searchState.totalHits > 0
                        ? NAVIGATION_COPY.hitCountDisplay(
                            searchState.currentHitIndex + 1,
                            searchState.totalHits
                          )
                        : '0 / 0'}
                    </span>
                    <button
                      type="button"
                      className="search-nav-btn search-prev-btn"
                      data-testid="search-prev-btn"
                      aria-label={NAVIGATION_COPY.prevHitAriaLabel}
                      title={NAVIGATION_COPY.prevHit}
                      onClick={handlePrevHit}
                      disabled={searchState.totalHits === 0}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="search-nav-btn search-next-btn"
                      data-testid="search-next-btn"
                      aria-label={NAVIGATION_COPY.nextHitAriaLabel}
                      title={NAVIGATION_COPY.nextHit}
                      onClick={handleNextHit}
                      disabled={searchState.totalHits === 0}
                    >
                      ↓
                    </button>
                  </div>
                )}

                {/* 搜索提示：未找到 / 回到第一处 / 另有 N 处在已剔除块中 */}
                {searchQuery.trim() !== '' &&
                  searchState.totalHits === 0 &&
                  searchState.hiddenHitsCount === 0 && (
                    <span className="search-tip search-not-found" data-testid="search-not-found">
                      {NAVIGATION_COPY.notFound(searchQuery.trim())}
                    </span>
                  )}

                {wrappedToast && (
                  <span className="search-tip search-wrapped-toast" data-testid="search-wrapped-tip">
                    {NAVIGATION_COPY.wrappedToFirst}
                  </span>
                )}

                {searchQuery.trim() !== '' && searchState.hiddenHitsCount > 0 && (
                  <div className="search-tip search-hidden-notice" data-testid="search-hidden-notice">
                    <span>
                      {searchState.hiddenHitsFilter === 'excluded'
                        ? NAVIGATION_COPY.otherHitsInExcluded(searchState.hiddenHitsCount)
                        : NAVIGATION_COPY.otherHitsInIncluded(searchState.hiddenHitsCount)}
                    </span>
                    <button
                      type="button"
                      className="search-switch-btn"
                      data-testid="search-switch-to-all"
                      onClick={() => handleFilterTabClick('all')}
                    >
                      {NAVIGATION_COPY.switchToAll}
                    </button>
                  </div>
                )}

                {/* 「跳至 #」序号定位输入框 */}
                <div className="order-jump-box" data-testid="order-jump-box">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="order-jump-input"
                    data-testid="order-jump-input"
                    placeholder={NAVIGATION_COPY.jumpPlaceholder}
                    aria-label={NAVIGATION_COPY.jumpAriaLabel}
                    value={orderInputValue}
                    onChange={(e) => {
                      setOrderInputValue(e.target.value);
                      if (orderJumpTip) setOrderJumpTip(null);
                    }}
                    onKeyDown={handleOrderKeyDown}
                  />
                  <button
                    type="button"
                    className="order-jump-btn"
                    data-testid="order-jump-btn"
                    onClick={handleOrderJump}
                  >
                    {NAVIGATION_COPY.jumpBtn}
                  </button>

                  {orderJumpTip && (
                    <div className="order-jump-popover" data-testid="order-jump-tip">
                      <span className="order-jump-tip-text">{orderJumpTip.text}</span>
                      {orderJumpTip.canSwitchToAll && (
                        <button
                          type="button"
                          className="order-jump-switch-btn"
                          data-testid="order-jump-switch-all"
                          onClick={handleSwitchToAllAndJump}
                        >
                          {NAVIGATION_COPY.switchToAllAndJump}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* 全部 / 保留 / 剔除 筛选 Tabs（从汇总条移到这里，Issue #29 §3） */}
                <div
                  className="summary-chips filter-tabs"
                  role="tablist"
                  aria-label={WORKBENCH_COPY.filterTabsAriaLabel}
                  data-testid="filter-tabs"
                >
                  {FILTER_TAB_ORDER.map((mode) => {
                    const isActive = currentFilter === mode;
                    const label =
                      mode === 'all'
                        ? NAVIGATION_COPY.filterAll(session.snapshot.blocks.length)
                        : mode === 'included'
                        ? NAVIGATION_COPY.filterIncluded(includedBlockCount)
                        : NAVIGATION_COPY.filterExcluded(session.snapshot.blocks.length - includedBlockCount);
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        id={`filter-tab-${mode}`}
                        aria-selected={isActive}
                        aria-controls={BLOCK_LIST_PANEL_ID}
                        // 漫游 tabindex：Tab 只停在当前页签，页签之间用方向键切换
                        tabIndex={isActive ? 0 : -1}
                        className={`summary-chip filter-tab ${isActive ? 'is-active' : ''}`}
                        data-testid={`filter-tab-${mode}`}
                        ref={(el) => {
                          filterTabRefs.current[mode] = el;
                        }}
                        data-filter={mode}
                        onClick={() => handleFilterTabClick(mode)}
                        onKeyDown={handleFilterTabKeyDown}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 右侧操作区：检查结果、导出与回到原文看看（Issue #31 & Issue #32） */}
              <div className="nav-toolbar-actions">
                <button
                  type="button"
                  className="action-btn action-preview"
                  data-testid="action-preview"
                  ref={previewBtnRef}
                  onClick={handleOpenPreview}
                  aria-label={PREVIEW_COPY.openButtonAria}
                >
                  {PREVIEW_COPY.openButton}
                </button>
                {exportProgressText && !isPreviewOpen && (
                  <span className="export-progress" role="status" data-testid="toolbar-export-progress">
                    {exportProgressText}
                  </span>
                )}
                <button
                  type="button"
                  className="action-btn action-export"
                  data-testid="action-export"
                  ref={exportBtnRef}
                  onClick={handleToolbarExport}
                  aria-label={EXPORT_COPY.toolbarExportAriaLabel}
                  aria-busy={exportProgress ? true : undefined}
                >
                  {EXPORT_COPY.toolbarExportButton}
                </button>
                <button
                  type="button"
                  className="action-btn action-return"
                  data-testid="action-return"
                  onClick={() => handleReturnToOriginal(undefined, session.snapshot.source.url)}
                >
                  {NAVIGATION_COPY.returnToOriginal}
                </button>
              </div>
            </nav>
            </>
          )}
          {!isReadOnly && instanceMode === 'writer' && <SavePanel getSnapshot={() => {
            flushSync(() => blockListRef.current?.flushPendingEdits());
            return stateRef.current.session?.snapshot;
          }} />}
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
                aria-label={WORKBENCH_COPY.closeClipNoteAria}
                type="button"
              >
                <CloseIcon />
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

          {/* 顶部色标条：纯印刷装饰，不承载信息 */}
          <div className="registration-bar" aria-hidden="true">
            <div className="cmyk-swatches">
              <span className="cmyk-swatch cmyk-swatch-cyan"></span>
              <span className="cmyk-swatch cmyk-swatch-magenta"></span>
              <span className="cmyk-swatch cmyk-swatch-yellow"></span>
              <span className="cmyk-swatch cmyk-swatch-black"></span>
              <span className="cmyk-swatch cmyk-swatch-vermilion"></span>
              <span className="cmyk-swatch cmyk-swatch-prussian"></span>
            </div>
          </div>

          <div className="sheet-body">
            {/* 左侧页边批注栏：只是批注标记的对齐轨道，真实批注由各内容块自己输出并关联到读屏 */}
            <div className="margin-track" aria-hidden="true"></div>

            {/* 右侧版心 */}
            <section className="main-bed">
              {/* 态 1: 清洗态 或 候选确认态（模态签条压在清洗页之上，旧会话照常渲染在背后并压暗，满足 §8.5「先呈现已有会话」） */}
              {session && (viewMode === 'cleaning' || viewMode === 'candidateConfirm') && (
                <div
                  className={`manuscript-slip ${isPreviewOpen ? 'is-preview-active' : ''}`}
                  data-testid="manuscript-slip"
                  inert={isReadOnly}
                >
                  {session.snapshot.captureWarnings?.filter(w => w.code === 'long-article').map(w => (
                    <div className="unstable-note" role="status" data-testid="long-article-note" key={w.code}>
                      <span className="note-badge">长文提示</span>
                      <span>{w.message}</span>
                    </div>
                  ))}
                  {/* 稳定探测超时标注夹签 */}
                  {session.snapshot.captureWarnings?.some(
                    (w) => w.code === 'capture-unstable' || w.code === 'unstable-capture'
                  ) && (
                    <div className="unstable-note" data-testid="unstable-note">
                      <span className="note-badge">{WORKBENCH_COPY.unstableBadge}</span>
                      <span>{WORKBENCH_COPY.unstableNote}</span>
                    </div>
                  )}

                  {/* 文章来源与标题：必须位于正文内容块之前 */}
                  <div className="slip-header" data-testid="slip-header">
                    <span className="slip-kicker">{WORKBENCH_COPY.slipKicker}</span>
                    <h1 className="slip-title" ref={titleRef} tabIndex={-1}>
                      {session.snapshot.source.title || WORKBENCH_COPY.untitledArticle}
                    </h1>
                    <div className="slip-meta">
                      {session.snapshot.source.account && (
                        <span className="meta-item meta-account">
                          <strong>{WORKBENCH_COPY.accountLabel}</strong>
                          {session.snapshot.source.account}
                        </span>
                      )}
                      {session.snapshot.source.publishedAt && (
                        <span className="meta-item meta-date">
                          <strong>{WORKBENCH_COPY.publishedAtLabel}</strong>
                          {session.snapshot.source.publishedAt}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 正文块流列表：ADR-0005 唯一渲染入口 */}
                  <BlockList
                    ref={blockListRef}
                    blocks={session.snapshot.blocks}
                    filter={currentFilter}
                    onFilterChange={setCurrentFilter}
                    onSearchStateChange={setSearchState}
                    onFocusFallback={handleFilterFocusFallback}
                    tabPanelLabelledBy={
                      viewMode === 'cleaning' && !isReadOnly ? `filter-tab-${currentFilter}` : undefined
                    }
                  />
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

              {/* 检查结果汇总预览模态对话框（压在清洗页之上，原生 <dialog> showModal() - Issue #31 & Issue #32） */}
              {session && viewMode === 'cleaning' && !isReadOnly && (
                <PreviewDialog
                  isOpen={isPreviewOpen}
                  snapshot={session.snapshot}
                  onClose={handleClosePreview}
                  onJumpToBlock={handleJumpToBlockFromPreview}
                  onRecoverExcluded={handleRecoverExcludedFromPreview}
                  onJumpToEmptyBlock={handleJumpToBlockFromPreview}
                  onExport={handlePreviewExport}
                  exportProgressText={exportProgressText}
                />
              )}

              {unlocalizedImages && <UnlocalizedImagesDialog images={unlocalizedImages}
                onDecision={decideImages}
                onBack={() => {
                  decideImages('cancel');
                  if (isPreviewOpen) closePreviewThen(() => exportBtnRef.current?.focus());
                }}
                onLocate={target => {
                  decideImages('cancel');
                  setIsPreviewOpen(false);
                  setImageEditTarget(target);
                }} />}

              {/* 导出结果反馈对话框（Issue #32） */}
              <ExportFeedbackDialog
                feedback={exportFeedback}
                onClose={() => {
                  setExportFeedback(null);
                  if (!isPreviewOpenRef.current) {
                    exportBtnRef.current?.focus({ preventScroll: true });
                  }
                }}
                onOpenPreview={handleOpenPreview}
              />

              {viewMode === 'corruptedRecord' && (
                <RecoveryPanel recovery={state.recovery ?? { kind: 'readError' }}
                  isReadOnly={isReadOnly} onRetry={async () => { try { await recoverProgress(); } catch {} }} onClear={clearRecovery} />
              )}

              {/* 态 4: 空态 (viewMode === 'empty') */}
              {viewMode === 'empty' && (
                <>
                  {/* 子视图 4.1: 整篇级失败卡片 */}
                  {emptySubState.splitError && (
                    <div className="article-failure-card" data-testid="article-failure-card">
                      <div className="notice-stamp error-stamp" aria-hidden="true">
                        <span>{WORKBENCH_COPY.splitErrorStamp}</span>
                      </div>
                      <div className="notice-header">
                        <span className="notice-sub">{WORKBENCH_COPY.splitErrorSub}</span>
                        <h2 className="notice-title">{WORKBENCH_COPY.splitErrorTitle}</h2>
                      </div>
                      <blockquote className="notice-verbatim-quote">
                        {WORKBENCH_COPY.splitErrorDetails(emptySubState.splitError.message)}
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
                          {WORKBENCH_COPY.returnToOriginal}
                        </button>
                        <button
                          type="button"
                          className="action-btn action-retry"
                          onClick={() => handleRetry(emptySubState.splitError?.tabId)}
                        >
                          {WORKBENCH_COPY.retry}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 子视图 4.2: 审校退单卡片（微信提示页或验证页） */}
                  {!emptySubState.splitError && emptySubState.notice && (
                    <div className="return-notice-card" data-testid="return-notice-card">
                      <div className="notice-stamp" aria-hidden="true">
                        <span>{WORKBENCH_COPY.noticeStamp}</span>
                      </div>
                      <div className="notice-header">
                        <span className="notice-sub">{WORKBENCH_COPY.noticeSub}</span>
                        <h2 className="notice-title">
                          {emptySubState.notice.kind === 'captcha'
                            ? WORKBENCH_COPY.captchaTitle
                            : WORKBENCH_COPY.wechatNoticeTitle}
                        </h2>
                      </div>

                      <blockquote className="notice-verbatim-quote">
                        {emptySubState.notice.kind === 'captcha'
                          ? WORKBENCH_COPY.captchaDetails
                          : WORKBENCH_COPY.quoteNotice(emptySubState.notice.noticeText)}
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
                          {WORKBENCH_COPY.returnToOriginal}
                        </button>
                        <button
                          type="button"
                          className="action-btn action-retry"
                          onClick={() => handleRetry(emptySubState.notice?.tabId)}
                        >
                          {WORKBENCH_COPY.retry}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 子视图 4.3: 默认空状态 - 3 步指引 */}
                  {!emptySubState.splitError && !emptySubState.notice && (
                    <div className="empty-state-view" data-testid="empty-state-view">
                      <h1 className="empty-headline" ref={focusEmptyRef} tabIndex={-1}>
                        <span className="empty-headline-accent"></span>
                        {WORKBENCH_COPY.emptyHeadline}
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

          {/* 构建自检结果只供验证脚本读取，不展示给用户 */}
          {selfTestPassed && (
            <span hidden data-testid="self-test-status">
              CSP / EVAL VERIFIED (TURNDOWN + GFM + MARKED + DOMPURIFY + REACT 19)
            </span>
          )}
        </main>
      </div>
    </AppContext.Provider>
  );
};
