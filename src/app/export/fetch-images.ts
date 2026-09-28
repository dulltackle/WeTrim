import type { ExportImageReference } from './markdown-image-refs';
import { EXPORT_COPY } from '../copy/export';

export type SupportedImageFormat =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'bmp'
  | 'avif'
  | 'ico';

export interface ImageFormatInfo {
  format: SupportedImageFormat;
  extension: string;
}

const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * 依据 Issue #33 与 PRODUCT.md 「导出」：
 * 保留下载到的原始字节，不转码；按实际媒体格式选扩展名，不能只凭 URL 后缀或固定 .jpg。
 * 返回 HTML 错误页、无法判定为受支持图片的数据，返回 null（按下载失败处理，不伪装成成功图片）。
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormatInfo | null {
  if (!bytes || bytes.length < 2) {
    return null;
  }

  const len = bytes.length;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    len >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { format: 'png', extension: '.png' };
  }

  // 2. JPEG: FF D8 FF
  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', extension: '.jpg' };
  }

  // 3. GIF: GIF87a 或 GIF89a
  if (
    len >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { format: 'gif', extension: '.gif' };
  }

  // 4. WebP: RIFF .... WEBP
  if (
    len >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { format: 'webp', extension: '.webp' };
  }

  // 5. BMP: "BM" 之后 4 字节保留位为 0，DIB 头长度只能是几种已知值（只看 "BM" 两字节会把普通文本误判为图片）
  if (len >= 18 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const reservedZero = bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0;
    const dibHeaderSize = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24);
    if (reservedZero && BMP_DIB_HEADER_SIZES.has(dibHeaderSize)) {
      return { format: 'bmp', extension: '.bmp' };
    }
  }

  // 6. AVIF: 4..7 为 'ftyp', 8..11 为 'avif' 或 'avis'
  if (
    len >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') {
      return { format: 'avif', extension: '.avif' };
    }
  }

  // 7. ICO: 00 00 01 00
  if (len >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { format: 'ico', extension: '.ico' };
  }

  // 8. SVG: 文本 XML，排除 HTML / DOCTYPE / JSON
  if (len >= 4) {
    let start = 0;
    // 忽略 UTF-8 BOM
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      start = 3;
    }
    // 忽略前置空白
    while (
      start < len &&
      (bytes[start] === 32 || bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13)
    ) {
      start++;
    }
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(start, Math.min(len, start + 1024))
    );
    if (
      /^(?:<\?xml\b[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(
        sample
      )
    ) {
      return { format: 'svg', extension: '.svg' };
    }
  }

  // 无法识别为受支持格式或为 HTML 错误页
  return null;
}

export interface FetchedImageSuccess {
  ok: true;
  url: string;
  bytes: Uint8Array;
  format: SupportedImageFormat;
  extension: string;
  fileName: string;
}

export interface FetchedImageFailure {
  ok: false;
  url: string;
  error: Error;
  status?: number;
}

export type FetchedImageResult = FetchedImageSuccess | FetchedImageFailure;

export interface FetchProgress {
  /** 累计已下载字节数（不按张数百分比估算进度） */
  downloadedBytes: number;
  /** 已处理完成的条目数（含成功与失败） */
  completedCount: number;
  /** 总条目数 */
  totalCount: number;
}

/** 单张图片连续这么久收不到任何数据即视为下载失败，避免一个挂起的请求卡住整次导出 */
export const IMAGE_STALL_TIMEOUT_MS = 20_000;

class ImageDownloadTimeoutError extends Error {
  constructor() {
    super(EXPORT_COPY.imageDownloadTimeout);
    this.name = 'ImageDownloadTimeoutError';
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 空闲计时器：每次收到数据时重置，超时后中止请求并让等待中的读取立即失败 */
function createStallGuard(timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new ImageDownloadTimeoutError()), timeoutMs);
  };
  const guard = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(new ImageDownloadTimeoutError());
        return;
      }
      const onAbort = () => reject(new ImageDownloadTimeoutError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
    });
  reset();
  return { signal: controller.signal, reset, guard, dispose: () => clearTimeout(timer) };
}

async function readBody(
  response: Response,
  stall: ReturnType<typeof createStallGuard>,
  onBytes?: (byteCount: number) => void
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await stall.guard(response.arrayBuffer()));
    onBytes?.(bytes.byteLength);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await stall.guard(reader.read());
      if (done) break;
      stall.reset();
      chunks.push(value);
      total += value.byteLength;
      onBytes?.(value.byteLength);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * 依据 ARCHITECTURE.md §1 与 §10.1：
 * 单张图片资源直接由扩展全页 fetch，带 referrerPolicy: 'no-referrer'。
 * service worker 明确不经手任何图片字节。
 */
export async function fetchImageResource(
  url: string,
  options?: {
    fileBaseName?: string;
    fetchFn?: typeof fetch;
    /** 每收到一段字节回调一次，供进度按实际下载字节累计 */
    onBytes?: (byteCount: number) => void;
    stallTimeoutMs?: number;
  }
): Promise<FetchedImageResult> {
  const fetchFn = options?.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!fetchFn) {
    return {
      ok: false,
      url,
      error: new Error('当前环境缺少 fetch 函数支持'),
    };
  }

  const stall = createStallGuard(options?.stallTimeoutMs ?? IMAGE_STALL_TIMEOUT_MS);
  try {
    const response = await stall.guard(
      fetchFn(url, {
        referrerPolicy: 'no-referrer',
        signal: stall.signal,
      })
    );

    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return {
        ok: false,
        url,
        status: response.status,
        error: new Error(`HTTP ${response.status} ${response.statusText}`),
      };
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.toLowerCase().includes('text/html')) {
      response.body?.cancel().catch(() => {});
      return {
        ok: false,
        url,
        status: response.status,
        error: new Error('响应为 HTML 页面，非有效图片数据'),
      };
    }

    const bytes = await readBody(response, stall, options?.onBytes);

    const formatInfo = detectImageFormat(bytes);
    if (!formatInfo) {
      return {
        ok: false,
        url,
        status: response.status,
        error: new Error('返回数据无法判定为受支持的图片格式'),
      };
    }

    const fileBaseName = options?.fileBaseName || 'image-001';
    const fileName = `${fileBaseName}${formatInfo.extension}`;

    return {
      ok: true,
      url,
      bytes,
      format: formatInfo.format,
      extension: formatInfo.extension,
      fileName,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      url,
      error: toError(err),
    };
  } finally {
    stall.dispose();
  }
}

export interface FetchAllExportImagesOptions {
  onProgress?: (progress: FetchProgress) => void;
  fetchFn?: typeof fetch;
  stallTimeoutMs?: number;
}

export interface FetchAllExportImagesResult {
  succeeded: FetchedImageSuccess[];
  failed: FetchedImageFailure[];
  urlToRelativePathMap: Map<string, string>;
}

/**
 * 依据 Issue #33 验收标准：
 * 批量下载并本地化图片，进度反馈按边下边累计的实际字节计算（不按张数百分比估算）。
 * 编号确定、有序，不要求下载失败后连续。
 */
export async function fetchAllExportImages(
  imageRefs: ExportImageReference[],
  options?: FetchAllExportImagesOptions
): Promise<FetchAllExportImagesResult> {
  const succeeded: FetchedImageSuccess[] = [];
  const failed: FetchedImageFailure[] = [];
  const urlToRelativePathMap = new Map<string, string>();

  let downloadedBytes = 0;
  let completedCount = 0;
  const totalCount = imageRefs.length;
  if (totalCount === 0) {
    return { succeeded, failed, urlToRelativePathMap };
  }

  const results: Array<FetchedImageSuccess | FetchedImageFailure> = new Array(totalCount);
  // 进度回调只是界面反馈，它抛错不能中断下载
  const reportProgress = () => {
    try {
      options?.onProgress?.({ downloadedBytes, completedCount, totalCount });
    } catch (err) {
      console.error('[WeTrim] 导出进度回调出错:', err);
    }
  };
  const concurrency = Math.min(6, totalCount);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < totalCount) {
      const idx = nextIndex++;
      const ref = imageRefs[idx];
      const res = await fetchImageResource(ref.resolvedUrl, {
        fileBaseName: ref.fileBaseName,
        fetchFn: options?.fetchFn,
        stallTimeoutMs: options?.stallTimeoutMs,
        onBytes: (byteCount) => {
          downloadedBytes += byteCount;
          reportProgress();
        },
      });

      results[idx] = res;
      completedCount++;
      reportProgress();
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  for (let idx = 0; idx < totalCount; idx++) {
    const ref = imageRefs[idx];
    const res = results[idx];
    if (res.ok) {
      succeeded.push(res);
      const relativePath = `images/${res.fileName}`;
      urlToRelativePathMap.set(ref.resolvedUrl, relativePath);
    } else {
      failed.push(res);
    }
  }

  return {
    succeeded,
    failed,
    urlToRelativePathMap,
  };
}
