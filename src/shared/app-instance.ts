/**
 * ARCHITECTURE.md §4.6 单实例保证：
 * 同时存在多个扩展全页时，按确定规则选出唯一写入方——tabId 最小者。
 * service worker（聚焦与叫醒哪个页面）与扩展全页（自己是否只读）必须共用这条规则，
 * 否则抓取结果可能被送到只读页。
 */
export function pickWriterContext<T extends { tabId?: number }>(contexts: readonly T[]): T | undefined {
  let writer: T | undefined;
  let writerTabId = Infinity;
  for (const ctx of contexts) {
    if (ctx.tabId === undefined || ctx.tabId < 0) continue;
    if (ctx.tabId < writerTabId) {
      writer = ctx;
      writerTabId = ctx.tabId;
    }
  }
  return writer;
}
