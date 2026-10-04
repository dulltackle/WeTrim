import { PENDING_CAPTURE_MESSAGE_TYPE } from '../shared/messages';
import { pickWriterContext } from '../shared/app-instance';

/**
 * 查询浏览器实时状态中的扩展全页写入方（ARCHITECTURE.md §4.6）。
 * 查的是浏览器实时状态而非 service worker 内存，因此跨 worker 重启有效。
 */
export async function findWriterAppContext(): Promise<chrome.runtime.ExtensionContext | undefined> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [chrome.runtime.getURL('app.html')],
  });
  return pickWriterContext(contexts ?? []);
}

/**
 * 打开或聚焦扩展全页 (app.html)
 * 依据 ARCHITECTURE.md §4.6 与 §4.3：
 * 若已有同类页面，则调用 chrome.tabs.update 聚焦写入方，不新开第二个；
 * 并向写入方发送 { type: 'pending-capture' } 叫醒消息（不带数据，只叫醒）。
 * 只读页不消费 pendingCapture，因此叫醒消息必须发给写入方。
 * 否则调用 chrome.tabs.create 打开新页面。
 */
export async function openOrFocusAppTab(): Promise<void> {
  try {
    const writer = await findWriterAppContext();

    if (writer && writer.tabId !== undefined) {
      const tabId = writer.tabId;
      await chrome.tabs.update(tabId, { active: true });
      if (writer.windowId !== undefined) {
        await chrome.windows.update(writer.windowId, { focused: true });
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

  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
}
