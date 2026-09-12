import { openOrFocusAppTab } from './app-tab';
import { captureTab, savePendingCapture } from './capture';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) {
    await savePendingCapture({ kind: 'noArticle' });
    await openOrFocusAppTab();
    return;
  }

  // 1. 注入并执行三档判定、稳定探测、提取 HTML 与元数据
  const result = await captureTab(tab.id);

  // 2. 写入 pendingCapture
  await savePendingCapture(result);

  // 3. 打开或聚焦扩展全页（全页已开则派发叫醒消息）
  await openOrFocusAppTab();
});

// 支持来自扩展全页的重试抓取请求
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && typeof message === 'object' && message.type === 'retry-capture') {
    (async () => {
      let targetTabId = message.tabId;
      if (typeof targetTabId !== 'number') {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = activeTab?.id;
        } catch {
          targetTabId = undefined;
        }
      }

      if (typeof targetTabId === 'number') {
        const result = await captureTab(targetTabId);
        await savePendingCapture(result);
        await openOrFocusAppTab();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    })();
    return true;
  }
});
