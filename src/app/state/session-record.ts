import type { Session } from '../../shared/types';

export const SESSION_SCHEMA_VERSION = 1;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const identity = (value: unknown): value is string => string(value) && value.length > 0;
const nullableString = (value: unknown) => value === null || string(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const timestamp = (value: unknown) => string(value) && Number.isFinite(Date.parse(value));
const blockTypes = new Set(['paragraph', 'heading', 'image', 'code', 'list', 'quote', 'table', 'divider', 'formula', 'richMedia', 'unknown']);

function notes(value: unknown): boolean {
  return Array.isArray(value) && value.every(note => object(note) &&
    string(note.code) && string(note.message) &&
    (note.imageAssetIds === undefined || (Array.isArray(note.imageAssetIds) && note.imageAssetIds.every(identity))));
}

/** 只校验，不补字段、不重新切块，也不改写原始记录。 */
export function isSessionRecord(value: unknown): value is Session {
  if (!object(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION ||
    !identity(value.sessionId) || !integer(value.revision) || !timestamp(value.savedAt)) return false;
  const snapshot = value.snapshot;
  if (!object(snapshot) || !identity(snapshot.snapshotId) || !timestamp(snapshot.capturedAt) ||
    !object(snapshot.source) || !string(snapshot.source.title) || !string(snapshot.source.url) ||
    !nullableString(snapshot.source.account) || !nullableString(snapshot.source.publishedAt) ||
    !notes(snapshot.captureWarnings) || !Array.isArray(snapshot.blocks) || !Array.isArray(snapshot.images)) return false;
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const block of snapshot.blocks) {
    if (!object(block) || !identity(block.id) || ids.has(block.id) || !integer(block.order) ||
      orders.has(block.order as number) || !string(block.type) || !blockTypes.has(block.type) ||
      !string(block.originalHtml) || !string(block.initialMarkdown) || !nullableString(block.editedMarkdown) ||
      typeof block.included !== 'boolean' || !notes(block.notes) ||
      (block.headingLevel !== undefined && (!Number.isInteger(block.headingLevel) ||
        (block.headingLevel as number) < 1 || (block.headingLevel as number) > 6))) return false;
    ids.add(block.id);
    orders.add(block.order as number);
  }
  const imageIds = new Set<string>();
  for (const image of snapshot.images) {
    if (!object(image) || !identity(image.id) || imageIds.has(image.id) || !string(image.url)) return false;
    imageIds.add(image.id);
  }
  return true;
}

export type SessionRecovery =
  | { kind: 'empty' }
  | { kind: 'ready'; session: Session }
  | { kind: 'readError' }
  | { kind: 'unrecognized'; raw: unknown };

// Git 历史从 cf3c275 定义格式、b752c21 开始持久化起均为 v1。
// 没有真实旧格式依据时不猜测迁移规则；未来格式也不能按 v1 自动写回。
export function decodeSessionRecord(raw: unknown): SessionRecovery {
  return isSessionRecord(raw) ? { kind: 'ready', session: raw } : { kind: 'unrecognized', raw };
}
