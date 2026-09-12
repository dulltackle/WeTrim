/**
 * 打开或聚焦扩展全页 (app.html)
 * 依据 ARCHITECTURE.md §4.6：
 * 用 chrome.runtime.getContexts 查浏览器实时状态。
 * 若已有同类页面，则调用 chrome.tabs.update 聚焦，不新开第二个；
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
      await chrome.tabs.update(contexts[0].tabId, { active: true });
      if (contexts[0].windowId !== undefined) {
        await chrome.windows.update(contexts[0].windowId, { focused: true });
      }
      return;
    }
  } catch (error) {
    console.warn('[WeTrim] getContexts query failed, falling back to create:', error);
  }

  await chrome.tabs.create({ url: appUrl });
}
