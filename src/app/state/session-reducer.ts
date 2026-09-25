import type { ArticleSnapshot, CaptureResult, Session } from '../../shared/types';

/**
 * ARCHITECTURE.md §7 & §8.5、Issue #24：
 * App 顶层状态机四态：
 * - empty: 空状态（含 3 步指引、微信提示页、验证页、无文章浮贴夹签、整篇级失败卡片）
 * - cleaning: 清洗状态（当前有效清洗会话，连续渲染全部内容块）
 * - candidateConfirm: 候选确认状态（已有当前会话时，新文章写入候选快照，等待用户拍板替换；#24 留壳，#28 实现）
 * - corruptedRecord: 损坏记录状态（存储记录格式无法识别或损坏；#24 留壳，#35 实现）
 */
export type AppViewMode = 'empty' | 'cleaning' | 'candidateConfirm' | 'corruptedRecord';

export interface EmptySubState {
  notice: Extract<CaptureResult, { kind: 'wechatNotice' | 'captcha' }> | null;
  marginClipNote: string | null;
  marginClipNoteAutoDismiss: boolean;
  splitError: {
    message: string;
    tabId?: number;
    url?: string;
  } | null;
}

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

export interface AppState {
  viewMode: AppViewMode;
  session: Session | null;
  candidateSnapshot: ArticleSnapshot | null;
  corruptedDetails: string | null;
  emptySubState: EmptySubState;
  selfTestPassed: boolean;
  saveStatus: SaveStatus;
  lastSavedRevision: number | null;
  isReadingArticle: boolean;
  isReadOnly: boolean;
}

export type SessionAction =
  | {
      type: 'INIT_STORAGE_STATE';
      payload: {
        session: Session | null;
        candidateSnapshot?: ArticleSnapshot | null;
        corrupted: boolean;
        corruptedDetails?: string;
        isReadOnly?: boolean;
      };
    }
  | {
      type: 'SET_ARTICLE_SNAPSHOT';
      payload: ArticleSnapshot;
    }
  | {
      type: 'DISCARD_CANDIDATE';
    }
  | {
      type: 'SET_READING_ARTICLE';
      payload: boolean;
    }
  | {
      type: 'SET_NEW_SESSION';
      payload: Session | { session: Session; saveStatus?: SaveStatus };
    }
  | {
      type: 'SET_SAVE_STATUS';
      payload: {
        status: SaveStatus;
        lastSavedRevision?: number;
      };
    }
  | {
      type: 'SET_EMPTY_NOTICE';
      payload: Extract<CaptureResult, { kind: 'wechatNotice' | 'captcha' }>;
    }
  | {
      type: 'SET_MARGIN_CLIP_NOTE';
      payload: string | { text: string; autoDismiss?: boolean } | null;
    }
  | {
      type: 'SET_SPLIT_ERROR';
      payload: { message: string; tabId?: number; url?: string } | null;
    }
  | {
      type: 'SET_VIEW_MODE';
      payload: AppViewMode;
    }
  | {
      type: 'SET_SELF_TEST_PASSED';
      payload: boolean;
    }
  | {
      type: 'SET_CORRUPTED_RECORD';
      payload: string;
    }
  | {
      type: 'TOGGLE_BLOCK';
      payload: { blockId: string };
    }
  | {
      type: 'UPDATE_BLOCK';
      payload: { blockId: string; editedMarkdown: string | null };
    }
  | {
      type: 'RESET_TO_EMPTY';
    };

export const initialEmptySubState: EmptySubState = {
  notice: null,
  marginClipNote: null,
  marginClipNoteAutoDismiss: true,
  splitError: null,
};

export const initialAppState: AppState = {
  viewMode: 'empty',
  session: null,
  candidateSnapshot: null,
  corruptedDetails: null,
  emptySubState: initialEmptySubState,
  selfTestPassed: false,
  saveStatus: 'saved',
  lastSavedRevision: null,
  isReadingArticle: false,
  isReadOnly: false,
};

export function sessionReducer(state: AppState, action: SessionAction): AppState {
  switch (action.type) {
    case 'INIT_STORAGE_STATE': {
      const { session, corrupted, corruptedDetails, isReadOnly } = action.payload;

      if (corrupted) {
        return {
          ...state,
          viewMode: 'corruptedRecord',
          corruptedDetails: corruptedDetails || '无法识别的会话数据格式',
          isReadOnly: Boolean(isReadOnly),
          isReadingArticle: false,
        };
      }

      // 依据 ARCHITECTURE.md §4.5 与 Issue #28：
      // 候选未处理就关闭扩展全页 -> 丢弃候选，下次打开直接恢复旧会话。
      // 候选永远不会自动提升为当前会话，启动时亦不自动进入候选确认态。
      if (session) {
        return {
          ...state,
          viewMode: 'cleaning',
          session,
          candidateSnapshot: null,
          saveStatus: 'saved',
          lastSavedRevision: session.revision,
          emptySubState: initialEmptySubState,
          isReadOnly: Boolean(isReadOnly),
          isReadingArticle: false,
        };
      }

      return {
        ...state,
        viewMode: 'empty',
        session: null,
        candidateSnapshot: null,
        saveStatus: 'saved',
        lastSavedRevision: null,
        isReadOnly: Boolean(isReadOnly),
        isReadingArticle: false,
      };
    }

    case 'SET_NEW_SESSION': {
      const newSession =
        'session' in action.payload ? action.payload.session : action.payload;
      const status =
        'saveStatus' in action.payload && action.payload.saveStatus
          ? action.payload.saveStatus
          : 'saving';
      return {
        ...state,
        viewMode: 'cleaning',
        session: newSession,
        saveStatus: status,
        lastSavedRevision: status === 'saved' ? newSession.revision : 0,
        candidateSnapshot: null,
        emptySubState: initialEmptySubState,
        isReadingArticle: false,
      };
    }

    case 'DISCARD_CANDIDATE': {
      return {
        ...state,
        viewMode: state.session ? 'cleaning' : 'empty',
        candidateSnapshot: null,
        isReadingArticle: false,
      };
    }

    case 'SET_READING_ARTICLE': {
      return {
        ...state,
        isReadingArticle: action.payload,
      };
    }

    case 'SET_SAVE_STATUS': {
      return {
        ...state,
        saveStatus: action.payload.status,
        lastSavedRevision:
          action.payload.lastSavedRevision !== undefined
            ? action.payload.lastSavedRevision
            : state.lastSavedRevision,
      };
    }

    case 'SET_ARTICLE_SNAPSHOT': {
      // 写入 candidateSnapshot 成功后触发本 action 进入 candidateConfirm
      return {
        ...state,
        viewMode: 'candidateConfirm',
        candidateSnapshot: action.payload,
        emptySubState: initialEmptySubState,
        isReadingArticle: false,
      };
    }

    case 'SET_EMPTY_NOTICE': {
      return {
        ...state,
        viewMode: 'empty',
        emptySubState: {
          ...state.emptySubState,
          notice: action.payload,
          splitError: null,
        },
      };
    }

    case 'SET_MARGIN_CLIP_NOTE': {
      if (typeof action.payload === 'object' && action.payload !== null) {
        return {
          ...state,
          emptySubState: {
            ...state.emptySubState,
            marginClipNote: action.payload.text,
            marginClipNoteAutoDismiss: action.payload.autoDismiss ?? true,
          },
        };
      }
      return {
        ...state,
        emptySubState: {
          ...state.emptySubState,
          marginClipNote: action.payload,
          marginClipNoteAutoDismiss: true,
        },
      };
    }

    case 'SET_SPLIT_ERROR': {
      if (action.payload) {
        return {
          ...state,
          viewMode: 'empty',
          emptySubState: {
            ...state.emptySubState,
            splitError: action.payload,
            notice: null,
          },
        };
      }
      return {
        ...state,
        emptySubState: {
          ...state.emptySubState,
          splitError: null,
        },
      };
    }

    case 'SET_VIEW_MODE': {
      return {
        ...state,
        viewMode: action.payload,
      };
    }

    case 'SET_SELF_TEST_PASSED': {
      return {
        ...state,
        selfTestPassed: action.payload,
      };
    }

    case 'SET_CORRUPTED_RECORD': {
      return {
        ...state,
        viewMode: 'corruptedRecord',
        corruptedDetails: action.payload,
      };
    }

    case 'TOGGLE_BLOCK': {
      if (!state.session) return state;
      const nextBlocks = state.session.snapshot.blocks.map((b) =>
        b.id === action.payload.blockId ? { ...b, included: !b.included } : b
      );
      return {
        ...state,
        saveStatus: 'saving',
        session: {
          ...state.session,
          revision: state.session.revision + 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            ...state.session.snapshot,
            blocks: nextBlocks,
          },
        },
      };
    }

    case 'UPDATE_BLOCK': {
      if (!state.session) return state;
      const nextBlocks = state.session.snapshot.blocks.map((b) =>
        b.id === action.payload.blockId ? { ...b, editedMarkdown: action.payload.editedMarkdown } : b
      );
      return {
        ...state,
        saveStatus: 'saving',
        session: {
          ...state.session,
          revision: state.session.revision + 1,
          savedAt: new Date().toISOString(),
          snapshot: {
            ...state.session.snapshot,
            blocks: nextBlocks,
          },
        },
      };
    }

    case 'RESET_TO_EMPTY': {
      return {
        ...initialAppState,
        selfTestPassed: state.selfTestPassed,
      };
    }

    default:
      return state;
  }
}
