import type { ArticleSnapshot } from '../../shared/types';
import { buildResultFile, composeResultText, type ResultFile } from './build-markdown';
import { sanitizeArticleTitle } from './sanitize-filename';
import { analyzeMarkdownImages } from './markdown-image-refs';
import {
  fetchAllExportImages,
  type FetchProgress,
  type FetchedImageSuccess,
  type FetchedImageFailure,
} from './fetch-images';
import { describeUnlocalizedImages, type UnlocalizedImage, type ImageDecision } from './unlocalized-images';
import { EXPORT_COPY } from '../copy/export';

export interface WriteDirectorySuccess {
  ok: true;
  articleDirName: string;
  markdownFileName: string;
  articleDirHandle: FileSystemDirectoryHandle;
  parentHandle: FileSystemDirectoryHandle;
  localizedImagesCount?: number;
  totalImagesCount?: number;
  failedImagesCount?: number;
}

export interface WriteDirectoryFailure {
  ok: false;
  error?: Error;
  emptyBody?: boolean;
  aborted?: boolean;
  /** 已有一次导出在进行中，本次请求被忽略 */
  busy?: boolean;
  message: string;
  /** 仅在本次确实创建了文章目录后才填写：此时目录可能残留未完整内容 */
  attemptedDirName?: string;
  stage?: 'pick' | 'prepare' | 'check_name' | 'create_dir' | 'write_file';
}

export type WriteDirectoryResult = WriteDirectorySuccess | WriteDirectoryFailure;

export interface WriteDirectoryOptions {
  resultFile?: ResultFile;
  onProgress?: (progress: FetchProgress) => void;
  fetchFn?: typeof fetch;
  hasPermission?: (url: string) => Promise<boolean>;
  onUnlocalized?: (images: UnlocalizedImage[]) => Promise<ImageDecision>;
}

export interface ExportArticleOptions extends WriteDirectoryOptions {
  parentHandle?: FileSystemDirectoryHandle;
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

export type ExportArticleResult = WriteDirectoryResult;

// 建目录后发现目录非空（查名与建目录之间被别处占用）时换名重试的上限
const MAX_CREATE_ATTEMPTS = 20;

/** 清洗结果是否有可导出的非空正文（导出链路唯一的判断口径） */
export function hasExportableBody(resultFile: ResultFile): boolean {
  return !!resultFile.body && resultFile.body.trim() !== '';
}

function emptyBodyFailure(): WriteDirectoryFailure {
  return {
    ok: false,
    emptyBody: true,
    message: EXPORT_COPY.emptyBodyTitle,
    stage: 'prepare',
  };
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message || String(err);
}

function nameCandidate(baseName: string, counter: number): string {
  return counter === 1 ? baseName : `${baseName} (${counter})`;
}

async function isEntryOccupied(
  lookup: () => Promise<unknown>
): Promise<boolean> {
  try {
    await lookup();
    return true;
  } catch (err: unknown) {
    const errName = (err as Error)?.name;
    // 同名条目存在但类型不同，同样视为被占用
    if (errName === 'TypeMismatchError') return true;
    if (errName === 'NotFoundError') return false;
    // 其他错误（如权限被拒等），向上抛出
    throw err;
  }
}

/**
 * 依据 PRODUCT.md 「导出」与 Issue #32 验收标准：
 * 重名时依次找 <文章文件名> (2)、(3) 等未占用名称。
 * 后缀只用于外层目录，内部 Markdown 文件仍用原清理后的文件名。
 * 不覆盖、不合并、不删除以前的结果。
 */
export async function findAvailableArticleDirectoryName(
  parentHandle: FileSystemDirectoryHandle,
  baseName: string,
  startCounter = 1
): Promise<{ name: string; counter: number }> {
  for (let counter = startCounter; ; counter++) {
    const candidate = nameCandidate(baseName, counter);
    if (await isEntryOccupied(() => parentHandle.getDirectoryHandle(candidate, { create: false }))) {
      continue;
    }
    if (
      typeof parentHandle.getFileHandle === 'function' &&
      (await isEntryOccupied(() => parentHandle.getFileHandle(candidate, { create: false })))
    ) {
      continue;
    }
    return { name: candidate, counter };
  }
}

/**
 * getDirectoryHandle(create: true) 遇到已存在的目录会直接返回它，没有「仅新建」语义。
 * 建完后确认目录为空，才能保证写入不会覆盖或合并到别处刚产生的同名目录。
 * lib.dom 未收录异步迭代器类型，这里按需探测。
 */
async function directoryHasEntries(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const keys = (dir as unknown as { keys?: () => AsyncIterator<string> }).keys;
  if (typeof keys !== 'function') return false;
  const first = await keys.call(dir).next();
  return !first.done;
}

/**
 * 依据 PRODUCT.md、ARCHITECTURE.md §10.3 与 Issue #32 验收标准：
 * 结构：<文章文件名>/<文章文件名>.md；没有本地图片时不创建 images/。
 * 复用 buildResultFile，正文为空时提示「没有可导出的正文」，不创建只含来源信息的文件。
 * 磁盘或权限导致写入失败时明确报告未完成及可能残留的本次目录，不报成功，不改动先前产物。
 */
export async function writeArticleDirectory(
  parentHandle: FileSystemDirectoryHandle,
  snapshot: ArticleSnapshot,
  options?: WriteDirectoryOptions
): Promise<WriteDirectoryResult> {
  // 1. 生成本次产物：从一次固定的当前内容生成
  const baseResultFile = options?.resultFile ?? buildResultFile(snapshot);

  // 2. 清洗结果没有非空正文时提示「没有可导出的正文」，不创建只含来源信息的文件
  if (!hasExportableBody(baseResultFile)) {
    return emptyBodyFailure();
  }

  // 3. 从保留块当前内容中的有效图片引用计算集合（ARCHITECTURE.md §10.1 与 Issue #33）
  //    收集与改写共用这一次分析，保证下载的图片和改写到的引用是同一批
  const imageAnalysis = analyzeMarkdownImages(baseResultFile.body, snapshot.source?.url);
  const imageRefs = imageAnalysis.references;

  // 4. 仅下载已授权的微信图片（全页自己 fetch）；失败项在写入前等待用户决定
  let localizedUrlMap = new Map<string, string>();
  let succeededImages: FetchedImageSuccess[] = [];
  let failedImages: FetchedImageFailure[] = [];

  if (imageRefs.length > 0) {
    const fetchResult = await fetchAllExportImages(imageRefs, {
      onProgress: options?.onProgress,
      fetchFn: options?.fetchFn,
      hasPermission: options?.hasPermission,
    });
    succeededImages = fetchResult.succeeded;
    failedImages = fetchResult.failed;
    localizedUrlMap = fetchResult.urlToRelativePathMap;
  }

  let problems = describeUnlocalizedImages(snapshot, imageAnalysis, localizedUrlMap, failedImages);
  while (problems.length > 0) {
    const decision = await options?.onUnlocalized?.(problems) ?? 'cancel';
    if (decision === 'continue' && problems.every(image => image.canKeepExternal)) break;
    if (decision !== 'retry') return { ok: false, aborted: true, stage: 'prepare', message: '已取消本次导出，尚未写入文件' };
    const failedUrls = new Set(failedImages.map(image => image.url));
    const retried = await fetchAllExportImages(imageRefs.filter(ref => failedUrls.has(ref.resolvedUrl)), options);
    succeededImages.push(...retried.succeeded);
    failedImages = retried.failed;
    for (const [url, path] of retried.urlToRelativePathMap) localizedUrlMap.set(url, path);
    problems = describeUnlocalizedImages(snapshot, imageAnalysis, localizedUrlMap, failedImages);
  }

  // 5. 本地化成功的路径和明确保留的相对网络地址只改写导出副本。
  // 相对网络地址必须带回文章基址，否则本地 Markdown 会把它误当成磁盘路径。
  const outputUrlMap = new Map(localizedUrlMap);
  for (const usage of imageAnalysis.usages) {
    if (!outputUrlMap.has(usage.resolvedUrl) && !/^https?:/i.test(usage.rawUrl)) {
      outputUrlMap.set(usage.resolvedUrl, usage.resolvedUrl.replace(/[()]/g, char => char === '(' ? '%28' : '%29'));
    }
  }
  const finalMarkdownText = outputUrlMap.size > 0
    ? composeResultText(baseResultFile.frontMatter, imageAnalysis.rewrite(outputUrlMap))
    : baseResultFile.text;

  // 6. 文件名清理：保留中文与 emoji，不反写 ArticleSource.title
  const baseName = sanitizeArticleTitle(snapshot.source?.title);
  const markdownFileName = `${baseName}.md`;

  let articleDirName = baseName;
  let articleDirHandle: FileSystemDirectoryHandle | null = null;
  let nextCounter = 1;

  // 7. 重名时依次找 <文章文件名> (2)、(3)；后缀只用于外层目录
  //    查名与建目录之间若同名目录被别处创建，换下一个名字重试
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS && !articleDirHandle; attempt++) {
    try {
      const found = await findAvailableArticleDirectoryName(parentHandle, baseName, nextCounter);
      articleDirName = found.name;
      nextCounter = found.counter + 1;
    } catch (err: unknown) {
      // 尚未创建任何目录，不存在本次残留
      return {
        ok: false,
        error: err as Error,
        message: `检查目录名称时失败: ${errorMessage(err)}`,
        stage: 'check_name',
      };
    }

    let created: FileSystemDirectoryHandle;
    try {
      // 创建文章目录
      created = await parentHandle.getDirectoryHandle(articleDirName, { create: true });
    } catch (err: unknown) {
      return {
        ok: false,
        error: err as Error,
        message: `创建文章目录失败: ${errorMessage(err)}`,
        stage: 'create_dir',
      };
    }

    try {
      if (!(await directoryHasEntries(created))) {
        articleDirHandle = created;
      }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err as Error,
        message: `检查文章目录时失败: ${errorMessage(err)}`,
        attemptedDirName: articleDirName,
        stage: 'create_dir',
      };
    }
  }

  if (!articleDirHandle) {
    return {
      ok: false,
      error: new Error('找不到可用的文章目录名'),
      message: '找不到可用的文章目录名',
      stage: 'create_dir',
    };
  }

  // 8. 写入图片：没有本地图片时不创建 images/；有本地图片时创建 images/ 并写入字节
  if (succeededImages.length > 0) {
    try {
      const imagesDirHandle = await articleDirHandle.getDirectoryHandle('images', { create: true });
      for (const img of succeededImages) {
        const imgFileHandle = await imagesDirHandle.getFileHandle(img.fileName, { create: true });
        const imgWritable = await imgFileHandle.createWritable();
        try {
          await imgWritable.write(img.bytes as unknown as BufferSource);
          await imgWritable.close();
        } catch (err) {
          try {
            await imgWritable.abort();
          } catch {}
          throw err;
        }
      }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err as Error,
        message: EXPORT_COPY.imageWriteFailed(errorMessage(err)),
        attemptedDirName: articleDirName,
        stage: 'write_file',
      };
    }
  }

  let writable: FileSystemWritableFileStream | null = null;
  try {
    // 9. 写入 Markdown 文件，结构为 <文章文件名>/<文章文件名>.md
    // 即使外层目录带 (2) 后缀，内部 Markdown 文件仍使用原清理后的文件名
    const fileHandle = await articleDirHandle.getFileHandle(markdownFileName, { create: true });
    writable = await fileHandle.createWritable();
    await writable.write(finalMarkdownText);
    await writable.close();
    writable = null;

    return {
      ok: true,
      articleDirName,
      markdownFileName,
      articleDirHandle,
      parentHandle,
      localizedImagesCount: succeededImages.length,
      failedImagesCount: problems.length,
      totalImagesCount: imageRefs.length,
    };
  } catch (err: unknown) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // 忽略中止失败
      }
    }
    // 磁盘或权限导致写入失败时明确报告未完成及可能残留的本次目录，不报成功，不改动先前产物
    return {
      ok: false,
      error: err as Error,
      message: `写入文件未完成: ${errorMessage(err)}`,
      attemptedDirName: articleDirName,
      stage: 'write_file',
    };
  }
}

/**
 * 完整导出流程：
 * 1. 检查是否有非空正文（避免无意义唤起目录选择器）
 * 2. 调 showDirectoryPicker() 选父目录
 * 3. 调用 writeArticleDirectory 写入
 * 用户取消（AbortError）视为正常取消，非错误。
 * 每次导出都打开目录选择器，不保存默认目录、不持久化目录句柄；不提供 ZIP，不引入 chrome.downloads。
 */
export async function exportArticleWithPicker(
  snapshot: ArticleSnapshot,
  options?: ExportArticleOptions
): Promise<ExportArticleResult> {
  const resultFile = options?.resultFile ?? buildResultFile(snapshot);

  if (!hasExportableBody(resultFile)) {
    return emptyBodyFailure();
  }

  let parentHandle = options?.parentHandle;

  if (!parentHandle) {
    const win =
      typeof window !== 'undefined'
        ? (window as unknown as {
            showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
          })
        : null;
    const pickerFn = options?.showDirectoryPicker ?? win?.showDirectoryPicker?.bind(win);

    if (!pickerFn) {
      return {
        ok: false,
        error: new Error('当前浏览器环境不支持文件夹选择 API'),
        message: '当前浏览器环境不支持文件夹选择 API',
        stage: 'pick',
      };
    }

    try {
      parentHandle = await pickerFn({ mode: 'readwrite' });
    } catch (err: unknown) {
      // 用户取消选择不是错误
      if ((err as Error)?.name === 'AbortError') {
        return {
          ok: false,
          aborted: true,
          message: '用户取消了文件夹选择',
          stage: 'pick',
        };
      }
      return {
        ok: false,
        error: err as Error,
        message: `选择文件夹失败: ${errorMessage(err)}`,
        stage: 'pick',
      };
    }
  }

  if (!parentHandle) {
    return {
      ok: false,
      message: '未能获取有效的目标文件夹',
      stage: 'pick',
    };
  }

  return await writeArticleDirectory(parentHandle, snapshot, {
    resultFile,
    onProgress: options?.onProgress,
    fetchFn: options?.fetchFn,
    hasPermission: options?.hasPermission,
    onUnlocalized: options?.onUnlocalized,
  });
}
