import type { ArticleSnapshot } from '../../shared/types';
import { buildResultFile, type ResultFile } from './build-markdown';
import { sanitizeArticleTitle } from './sanitize-filename';

export interface WriteDirectorySuccess {
  ok: true;
  articleDirName: string;
  markdownFileName: string;
  articleDirHandle: FileSystemDirectoryHandle;
  parentHandle: FileSystemDirectoryHandle;
}

export interface WriteDirectoryFailure {
  ok: false;
  error?: Error;
  emptyBody?: boolean;
  aborted?: boolean;
  message: string;
  attemptedDirName?: string;
  stage?: 'pick' | 'prepare' | 'check_name' | 'create_dir' | 'write_file';
}

export type WriteDirectoryResult = WriteDirectorySuccess | WriteDirectoryFailure;

export interface ExportArticleOptions {
  parentHandle?: FileSystemDirectoryHandle;
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  resultFile?: ResultFile;
}

export type ExportArticleResult = WriteDirectoryResult;

/**
 * 依据 PRODUCT.md 「导出」与 Issue #32 验收标准：
 * 重名时依次找 <文章文件名> (2)、(3) 等未占用名称。
 * 后缀只用于外层目录，内部 Markdown 文件仍用原清理后的文件名。
 * 不覆盖、不合并、不删除以前的结果。
 */
export async function findAvailableArticleDirectoryName(
  parentHandle: FileSystemDirectoryHandle,
  baseName: string
): Promise<string> {
  let candidate = baseName;
  let counter = 1;

  while (true) {
    let occupied = false;

    // 检查是否有同名目录
    try {
      await parentHandle.getDirectoryHandle(candidate, { create: false });
      occupied = true;
    } catch (err: unknown) {
      const errName = (err as Error)?.name;
      if (errName === 'TypeMismatchError') {
        // 同名条目存在但为文件，同样视为被占用
        occupied = true;
      } else if (errName !== 'NotFoundError') {
        // 其他错误（如权限被拒等），向上抛出
        throw err;
      }
    }

    if (occupied) {
      counter++;
      candidate = `${baseName} (${counter})`;
      continue;
    }

    // 目录未占用，进一步检查是否有同名文件
    if (typeof parentHandle.getFileHandle === 'function') {
      try {
        await parentHandle.getFileHandle(candidate, { create: false });
        occupied = true;
      } catch (err: unknown) {
        const errName = (err as Error)?.name;
        if (errName === 'TypeMismatchError') {
          // 同名条目为目录（防御性标记）
          occupied = true;
        } else if (errName !== 'NotFoundError') {
          throw err;
        }
      }
    }

    if (occupied) {
      counter++;
      candidate = `${baseName} (${counter})`;
      continue;
    }

    // 既无同名目录也无同名文件，该名称可用
    return candidate;
  }
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
  options?: { resultFile?: ResultFile }
): Promise<WriteDirectoryResult> {
  // 1. 生成本次产物：从一次固定的当前内容生成
  const resultFile = options?.resultFile ?? buildResultFile(snapshot);

  // 2. 清洗结果没有非空正文时提示「没有可导出的正文」，不创建只含来源信息的文件
  if (!resultFile.body || resultFile.body.trim() === '') {
    return {
      ok: false,
      emptyBody: true,
      message: '没有可导出的正文',
      stage: 'prepare',
    };
  }

  // 3. 文件名清理：保留中文与 emoji，不反写 ArticleSource.title
  const baseName = sanitizeArticleTitle(snapshot.source?.title);
  const markdownFileName = `${baseName}.md`;

  let articleDirName = baseName;
  let articleDirHandle: FileSystemDirectoryHandle | null = null;

  try {
    // 4. 重名时依次找 <文章文件名> (2)、(3)；后缀只用于外层目录
    articleDirName = await findAvailableArticleDirectoryName(parentHandle, baseName);
  } catch (err: unknown) {
    return {
      ok: false,
      error: err as Error,
      message: `检查目录名称时失败: ${(err as Error)?.message || String(err)}`,
      attemptedDirName: articleDirName,
      stage: 'check_name',
    };
  }

  try {
    // 5. 创建文章目录
    articleDirHandle = await parentHandle.getDirectoryHandle(articleDirName, { create: true });
  } catch (err: unknown) {
    return {
      ok: false,
      error: err as Error,
      message: `创建文章目录失败: ${(err as Error)?.message || String(err)}`,
      attemptedDirName: articleDirName,
      stage: 'create_dir',
    };
  }

  let writable: FileSystemWritableFileStream | null = null;
  try {
    // 6. 写入 Markdown 文件，结构为 <文章文件名>/<文章文件名>.md
    // 即使外层目录带 (2) 后缀，内部 Markdown 文件仍使用原清理后的文件名
    const fileHandle = await articleDirHandle.getFileHandle(markdownFileName, { create: true });
    writable = await fileHandle.createWritable();
    await writable.write(resultFile.text);
    await writable.close();
    writable = null;

    // 本票不含图片下载（#33），因此「没有本地图片时不创建 images/」成立
    return {
      ok: true,
      articleDirName,
      markdownFileName,
      articleDirHandle,
      parentHandle,
    };
  } catch (err: unknown) {
    if (writable) {
      try {
        await (writable as FileSystemWritableFileStream).abort();
      } catch {
        // 忽略中止失败
      }
    }
    // 磁盘或权限导致写入失败时明确报告未完成及可能残留的本次目录，不报成功，不改动先前产物
    return {
      ok: false,
      error: err as Error,
      message: `写入文件未完成，可能残留目录「${articleDirName}」: ${(err as Error)?.message || String(err)}`,
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

  if (!resultFile.body || resultFile.body.trim() === '') {
    return {
      ok: false,
      emptyBody: true,
      message: '没有可导出的正文',
      stage: 'prepare',
    };
  }

  let parentHandle = options?.parentHandle;

  if (!parentHandle) {
    const win = typeof window !== 'undefined'
      ? (window as unknown as {
          showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
        })
      : null;
    const pickerFn = options?.showDirectoryPicker ?? win?.showDirectoryPicker?.bind(win);

    if (!pickerFn) {
      return {
        ok: false,
        error: new Error('当前环境不支持 showDirectoryPicker'),
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
        message: `选择文件夹失败: ${(err as Error)?.message || String(err)}`,
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
  });
}
