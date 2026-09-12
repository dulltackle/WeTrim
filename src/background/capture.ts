import type { CaptureResult } from '../shared/types';
import { STORAGE_KEYS } from '../shared/storage-keys';

/**
 * 抓取结果写入 pendingCapture（占位实现，后续票完善 executeScript 注入与捕获）
 */
export async function savePendingCapture(result: CaptureResult): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PENDING_CAPTURE]: {
      capturedAt: new Date().toISOString(),
      result,
    },
  });
}
