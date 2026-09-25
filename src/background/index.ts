import { findWriterAppContext, openOrFocusAppTab } from './app-tab';
import { captureTab, savePendingCapture } from './capture';
import { STORAGE_KEYS } from '../shared/storage-keys';
import type { CandidateRecord } from '../shared/types';

/**
 * ARCHITECTURE.md §4.5 与 Issue #28：
 * service worker 抓取进行中防重入标志位。
 * 必须在第一个 await 之前同步置位，否则两次快速点击都会越过检查而并发抓取。
 */
let isCapturing = false;

/**
 * 已有候选且是同一 URL 时，只有扩展全页仍开着（确认框仍在）才算「把已有确认框摆回来」。
 * 全页已关闭时残留的候选会在下次启动时被丢弃，此时必须照常抓取，否则这次点击会被吞掉。
 */
async function hasPendingCandidateFor(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
    const candidateRecord = data[STORAGE_KEYS.CANDIDATE_SNAPSHOT] as CandidateRecord | undefined;
    if (candidateRecord?.snapshot?.source?.url !== url) return false;
    return (await findWriterAppContext()) !== undefined;
  } catch (err) {
    console.warn('[WeTrim Background] Error checking candidateSnapshot URL:', err);
    return false;
  }
}

async function handleActionClick(tab: Pick<chrome.tabs.Tab, 'id' | 'url'>): Promise<void> {
  // 1. 抓取进行中再点图标 -> 忽略，只聚焦扩展全页，不并发抓两次
  if (isCapturing) {
    await openOrFocusAppTab();
    return;
  }

  isCapturing = true;
  try {
    if (tab.id === undefined) {
      await savePendingCapture({ kind: 'noArticle' });
      await openOrFocusAppTab();
      return;
    }

    // 2. 已有候选且是同一 URL -> 不重新抓取，聚焦全页并把已有确认框摆回来
    if (await hasPendingCandidateFor(tab.url)) {
      await openOrFocusAppTab();
      return;
    }

    // 3. 正常抓取：注入并执行三档判定、稳定探测、提取 HTML 与元数据
    const result = await captureTab(tab.id);
    // 写入 pendingCapture
    await savePendingCapture(result);
    // 打开或聚焦扩展全页（全页已开则派发叫醒消息）
    await openOrFocusAppTab();
  } finally {
    isCapturing = false;
  }
}

chrome.action.onClicked.addListener(handleActionClick);

// 暴露测试辅助钩子（供自动化测试在 service worker 中直接调用点击入口）
(globalThis as unknown as Record<string, unknown>).__wetrimBackground = { handleActionClick };

// 支持来自扩展全页整篇级失败卡片与审校退单卡片的重试抓取请求（必须带明确 tabId）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && typeof message === 'object' && message.type === 'retry-capture') {
    (async () => {
      const targetTabId = message.tabId;
      if (typeof targetTabId !== 'number') {
        sendResponse({ success: false, error: 'tabId is required for retry-capture' });
        return;
      }

      if (isCapturing) {
        await openOrFocusAppTab();
        sendResponse({ success: true, ignored: true });
        return;
      }

      try {
        isCapturing = true;
        const result = await captureTab(targetTabId);
        await savePendingCapture(result);
        await openOrFocusAppTab();
        sendResponse({ success: true });
      } finally {
        isCapturing = false;
      }
    })();
    return true;
  }
});
