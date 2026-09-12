import type { Session } from '../../shared/types';
import { STORAGE_KEYS } from '../../shared/storage-keys';

export async function loadSession(): Promise<Session | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_SESSION);
  const session = data[STORAGE_KEYS.CURRENT_SESSION] as Session | undefined;
  return session ?? null;
}
