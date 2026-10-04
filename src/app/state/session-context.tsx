import React, { createContext, useContext } from 'react';
import type { AppState, SessionAction } from './session-reducer';
import type { Session } from '../../shared/types';

export interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<SessionAction>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used within an AppContext.Provider');
  }
  return ctx;
}

export function useSession(): Session | null {
  const ctx = useContext(AppContext);
  return ctx?.state.session ?? null;
}
