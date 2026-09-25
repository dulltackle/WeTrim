import type { Session } from '../../shared/types';
import { STORAGE_KEYS } from '../../shared/storage-keys';
import type { SaveStatus } from './session-reducer';

export type { SaveStatus };

export interface SaveStatusMeta {
  revision?: number;
  sessionId?: string;
  error?: unknown;
}

export type SaveStatusListener = (status: SaveStatus, meta?: SaveStatusMeta) => void;

/**
 * ARCHITECTURE.md §8.1:
 * - chrome.storage.local 三个固定 key: currentSession / candidateSnapshot / pendingCapture
 * - 本票实现 currentSession 的读写，不按文章建索引、不建历史库
 * - 会话按单个 key 整篇序列化，不分块
 */

export async function loadSession(): Promise<Session | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_SESSION);
  const session = data[STORAGE_KEYS.CURRENT_SESSION] as Session | undefined;
  return session ?? null;
}

export async function saveSessionDirect(session: Session): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  // 整篇序列化写入单个 key，不分块
  await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_SESSION]: session });
}

export async function clearSessionDirect(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEYS.CURRENT_SESSION);
}

/**
 * ARCHITECTURE.md §8.2、§8.3、§7.1 与 Issue #26 规范：
 * 写入串行化单队列 + revision 单调递增：
 * - 发起写入时记下当时的 revision，写成功后只有它仍等于当前 revision 才显示「已保存」
 * - 较旧修订完成时，不得把之后的新编辑误标为已保存
 * - 清除或替换后，旧会话的迟到写入不得复活或覆盖
 * - 声明了 unlimitedStorage 仍要处理磁盘空间不足、API 拒绝等保存失败；失败时不自动删除原始内容、剔除块或其他数据来降级
 * - 不依赖关闭页面时的异步补存；隐藏页面时可尽早提交待保存内容，但恢复边界是最后一次成功保存
 */
export class SessionSaveQueue {
  private inFlightSession: Session | null = null;
  private pendingSession: Session | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private activeSessionId: string | null = null;
  private lastSavedRevision: number = 0;
  private lastError: unknown = null;
  private currentStatus: SaveStatus = 'saved';
  private listeners: Set<SaveStatusListener> = new Set();

  public getStatus(): SaveStatus {
    return this.currentStatus;
  }

  public getLastSavedRevision(): number {
    return this.lastSavedRevision;
  }

  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  public subscribe(listener: SaveStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus, {
      revision: this.lastSavedRevision,
      sessionId: this.activeSessionId ?? undefined,
      error: this.lastError ?? undefined,
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(status: SaveStatus, meta?: SaveStatusMeta): void {
    this.currentStatus = status;
    for (const listener of this.listeners) {
      try {
        listener(status, meta);
      } catch (err) {
        console.error('[SessionSaveQueue] Listener error:', err);
      }
    }
  }

  /**
   * 重开扩展全页直接恢复上次成功保存的内容时调用：
   * 直接恢复，标记为已保存，不触发写入，不经过“正在保存”闪烁。
   */
  public initLoaded(session: Session): void {
    this.activeSessionId = session.sessionId;
    this.lastSavedRevision = session.revision;
    this.inFlightSession = null;
    this.pendingSession = null;
    this.inFlightPromise = null;
    this.lastError = null;
    this.notify('saved', { revision: session.revision, sessionId: session.sessionId });
  }

  /**
   * 取舍（保留/剔除）与明确的还原操作触发立即提交入队。
   */
  public enqueue(session: Session): void {
    // 若换成了新会话，重置并丢弃旧会话挂起的待写入
    if (this.activeSessionId !== session.sessionId) {
      this.activeSessionId = session.sessionId;
      this.pendingSession = null;
      this.lastSavedRevision = 0;
      this.lastError = null;
    }

    // 若当前正在写入中
    if (this.inFlightPromise !== null) {
      this.pendingSession = session;
      // 当前写入在途的是较旧修订，而内存中已有更新的修订：
      // 最新更改未保存（写入尚未发起，或已发起但未返回）
      this.notify('unsaved', {
        revision: session.revision,
        sessionId: session.sessionId,
      });
      return;
    }

    // 当前空闲，立即发起写入
    this.startWrite(session);
  }

  /**
   * 保存失败时提供重试
   */
  public retry(session?: Session): void {
    const targetSession = session || this.pendingSession || this.inFlightSession;
    if (!targetSession) return;
    this.lastError = null;
    this.pendingSession = null;
    this.enqueue(targetSession);
  }

  /**
   * 清除会话：丢弃挂起写入，并从 storage 中移除 key。
   * 旧会话迟到写入不得复活或覆盖。
   */
  public async clear(): Promise<void> {
    this.activeSessionId = null;
    this.pendingSession = null;
    this.lastError = null;
    this.lastSavedRevision = 0;
    if (this.inFlightPromise) {
      try {
        await this.inFlightPromise;
      } catch {
        // 忽略在途写入异常
      }
    }
    try {
      await clearSessionDirect();
    } catch (err) {
      console.warn('[SessionSaveQueue] clearSessionDirect error:', err);
    }
    this.notify('saved');
  }

  /**
   * 隐藏页面时尽早提交待保存内容（ARCHITECTURE.md §8.2）；
   * 替换会话前等待旧会话在途写入结束。
   *
   * 写入失败时 startWrite 会把该修订挂回 pendingSession 以供重试，
   * 因此遇到失败必须停止：否则存储持续拒绝写入（如磁盘空间不足）时会无限重写，调用方永远等不到返回。
   */
  public async flush(): Promise<void> {
    while (this.inFlightPromise || this.pendingSession) {
      if (this.pendingSession && !this.inFlightPromise) {
        const next = this.pendingSession;
        this.pendingSession = null;
        this.startWrite(next);
      }
      if (this.inFlightPromise) {
        await this.inFlightPromise;
      }
      if (this.lastError !== null) {
        break;
      }
    }
  }

  private startWrite(session: Session): void {
    const targetSessionId = session.sessionId;
    const writingRevision = session.revision;

    this.inFlightSession = session;
    this.lastError = null;
    if (
      this.pendingSession &&
      this.pendingSession.sessionId === targetSessionId &&
      this.pendingSession.revision === writingRevision
    ) {
      this.pendingSession = null;
    }
    this.notify('saving', { revision: writingRevision, sessionId: targetSessionId });

    this.inFlightPromise = (async () => {
      try {
        await saveSessionDirect(session);

        // 写入完成，检查是否已被清除或被新会话替换
        if (this.activeSessionId !== targetSessionId) {
          // 清除或替换后，旧会话的迟到写入不得复活或覆盖
          if (this.activeSessionId === null) {
            try {
              await clearSessionDirect();
            } catch (err) {
              console.warn('[SessionSaveQueue] clearSessionDirect after late write error:', err);
            }
          }
          // 若新会话已有待写入请求排队，立即触发新会话写入
          if (this.pendingSession && this.pendingSession.sessionId === this.activeSessionId) {
            const next = this.pendingSession;
            this.pendingSession = null;
            this.inFlightPromise = null;
            this.startWrite(next);
          }
          return;
        }

        this.lastSavedRevision = writingRevision;
        this.lastError = null;

        // 检查在写入期间是否有更新的待写入请求入队
        if (this.pendingSession !== null) {
          const next = this.pendingSession;
          this.pendingSession = null;
          // 继续执行下一个写入（串行队列）
          this.inFlightPromise = null;
          this.startWrite(next);
          return;
        }

        // 只有最新修订保存成功才显示「已保存」；较旧修订完成时，不得把之后的新编辑误标为已保存
        this.notify('saved', { revision: writingRevision, sessionId: targetSessionId });
      } catch (err) {
        console.warn('[SessionSaveQueue] Write failed:', err);
        // 检查会话是否仍然有效
        if (this.activeSessionId !== targetSessionId) {
          return;
        }

        this.lastError = err;
        // 保存失败：内存中的编辑仍可继续使用和导出，保留 pendingSession 以供重试
        if (!this.pendingSession) {
          this.pendingSession = session;
        }

        this.notify('error', {
          revision: writingRevision,
          sessionId: targetSessionId,
          error: err,
        });
      } finally {
        if (this.inFlightSession === session) {
          this.inFlightSession = null;
          this.inFlightPromise = null;
        }
      }
    })();
  }
}

export const sessionSaveQueue = new SessionSaveQueue();
