/**
 * A bounded snapshot of the user's desktop context captured for one dictation.
 * The host validates and bounds untrusted snapshots before using them.
 */
export interface ContextSnapshot {
  capturedAt: number;
  app?: {
    name: string;
    windowTitle?: string;
    wmClass?: string;
    url?: string;
  };
  terminal?: {
    paneText: string;
  };
  editor?: {
    file?: string;
    language?: string;
    visibleText?: string;
    symbols?: string[];
    openBuffers?: string[];
  };
  focusText?: {
    before: string;
    selected?: string;
    after?: string;
    role?: string;
  };
}
