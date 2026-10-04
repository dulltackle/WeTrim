export const PENDING_CAPTURE_MESSAGE_TYPE = 'pending-capture' as const;

export interface PendingCaptureMessage {
  type: typeof PENDING_CAPTURE_MESSAGE_TYPE;
}

export type ExtensionMessage = PendingCaptureMessage;
