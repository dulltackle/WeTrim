import type { Session } from '../../shared/types';

export type SessionAction = { type: 'RESET' };

export function sessionReducer(state: Session | null, _action: SessionAction): Session | null {
  return state;
}
