export const STORAGE_KEYS = {
  CURRENT_SESSION: 'currentSession',
  CANDIDATE_SNAPSHOT: 'candidateSnapshot',
  PENDING_CAPTURE: 'pendingCapture',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
