import { pickWriterContext } from '../../shared/app-instance';

let enabled = false;
export function setWriterEnabled(value: boolean): void { enabled = value; }

/** 每次写入都重新查询浏览器；worker 重启不影响资格，查询失败一律拒绝。 */
export async function queryWriter() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return { isWriter: true, writer: undefined };
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')],
  });
  const current = await chrome.tabs.getCurrent();
  const writer = pickWriterContext(contexts);
  if (!writer || current?.id === undefined || !contexts.some(context => context.tabId === current.id)) {
    throw new Error('暂时无法确认编辑页面');
  }
  return { isWriter: writer.tabId === current.id, writer };
}

/** 跨页面串行化资格检查与存储操作；接管读取也等待此前已发出的写入完成。 */
export async function withWriterAccess<T>(operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request('wetrim-session-writer', async () => {
    if (!enabled || !(await queryWriter()).isWriter || !enabled) throw new Error('当前页面没有写入资格');
    return operation();
  });
}

export const writerStorage = {
  set: (items: Record<string, unknown>) => withWriterAccess(() => chrome.storage.local.set(items)),
  remove: (keys: string | string[]) => withWriterAccess(() => chrome.storage.local.remove(keys)),
};
