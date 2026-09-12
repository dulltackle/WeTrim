import type { CaptureResult } from '../shared/types';
import { STORAGE_KEYS } from '../shared/storage-keys';
import { capturePage } from '../content/capture';

/**
 * 注入 content script 抓取页面。
 * 依据 ARCHITECTURE.md §4.3：
 * executeScript 本身 reject（受限页面注入失败）时，service worker 合成 { kind: 'noArticle' }——失败本身即信号。
 */
export async function captureTab(tabId: number): Promise<CaptureResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: capturePage,
    });
    const result = results?.[0]?.result as CaptureResult | undefined;
    if (result && typeof result === 'object' && 'kind' in result) {
      return { ...result, tabId };
    }
    return { kind: 'noArticle', tabId };
  } catch (error) {
    // 注入失败（chrome://、网上应用店、其他受限页面）-> 自动合成通用失败
    return { kind: 'noArticle', tabId };
  }
}

/**
 * 抓取结果写入 pendingCapture（包含 capturedAt 与 result）
 */
export async function savePendingCapture(result: CaptureResult): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PENDING_CAPTURE]: {
      capturedAt: new Date().toISOString(),
      result,
    },
  });
}
