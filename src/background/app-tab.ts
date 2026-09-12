import { PENDING_CAPTURE_MESSAGE_TYPE } from '../shared/messages';

/**
 * 打开或聚焦扩展全页 (app.html)
 * 依据 ARCHITECTURE.md §4.6 与 §4.3：
 * 用 chrome.runtime.getContexts 查浏览器实时状态。
 * 若已有同类页面，则调用 chrome.tabs.update 聚焦，不新开第二个；
 * 并发送 { type: 'pending-capture' } 叫醒消息（不带数据，只叫醒）。
 * 否则调用 chrome.tabs.create 打开新页面。
 */
export async function openOrFocusAppTab(): Promise<void> {
  const appUrl = chrome.runtime.getURL('app.html');
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [appUrl],
    });

    if (contexts && contexts.length > 0 && contexts[0].tabId !== undefined) {
      const tabId = contexts[0].tabId;
      await chrome.tabs.update(tabId, { active: true });
      if (contexts[0].windowId !== undefined) {
        await chrome.windows.update(contexts[0].windowId, { focused: true });
      }
      // 发送叫醒消息通知已有全页读取 pendingCapture
      try {
        await chrome.tabs.sendMessage(tabId, { type: PENDING_CAPTURE_MESSAGE_TYPE });
      } catch {
        // 若目标标签页尚未就绪，页面 mount 时会自动检查 pendingCapture
      }
      return;
    }
  } catch (error) {
    console.warn('[WeTrim] getContexts query failed, falling back to create:', error);
  }

  await chrome.tabs.create({ url: appUrl });
}
