import { openOrFocusAppTab } from './app-tab';
import { captureTab, savePendingCapture } from './capture';
import { STORAGE_KEYS } from '../shared/storage-keys';
import type { CandidateRecord } from '../shared/types';

/**
 * ARCHITECTURE.md §4.5 与 Issue #28：
 * service worker 抓取进行中防重入标志位
 */
let isCapturing = false;

chrome.action.onClicked.addListener(async (tab) => {
  // 1. 抓取进行中再点图标 -> 忽略，只聚焦扩展全页，不并发抓两次
  if (isCapturing) {
    await openOrFocusAppTab();
    return;
  }

  if (tab.id === undefined) {
    await savePendingCapture({ kind: 'noArticle' });
    await openOrFocusAppTab();
    return;
  }

  // 2. 已有候选且是同一 URL -> 不重新抓取，聚焦全页并把已有确认框摆回来
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.CANDIDATE_SNAPSHOT);
    const candidateRecord = data[STORAGE_KEYS.CANDIDATE_SNAPSHOT] as CandidateRecord | undefined;
    if (tab.url && candidateRecord?.snapshot?.source?.url === tab.url) {
      await openOrFocusAppTab();
      return;
    }
  } catch (err) {
    console.warn('[WeTrim Background] Error checking candidateSnapshot URL:', err);
  }

  // 3. 正常抓取
  try {
    isCapturing = true;
    // 注入并执行三档判定、稳定探测、提取 HTML 与元数据
    const result = await captureTab(tab.id);
    // 写入 pendingCapture
    await savePendingCapture(result);
    // 打开或聚焦扩展全页（全页已开则派发叫醒消息）
    await openOrFocusAppTab();
  } finally {
    isCapturing = false;
  }
});

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
