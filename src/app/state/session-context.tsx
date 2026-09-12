import React, { createContext, useContext } from 'react';
import type { Session } from '../../shared/types';

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session | null {
  return useContext(SessionContext);
}
