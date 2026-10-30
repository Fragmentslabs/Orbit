import { create } from "zustand";

import type { WsMatchOptions } from "@/src/lib/ipc";

/** Replacement in the open file's buffer, published by the files tab. */
export type ReplaceInOpenFile = (
  query: string,
  replacement: string,
  options: WsMatchOptions,
) => number;

/**
 * What the files tab publishes when there is a text editor in focus: which
 * file it is (so the palette knows whether it can offer "in this file") and how
 * to replace in its buffer.
 */
export interface ReplaceRegistry {
  path: string;
  run: ReplaceInOpenFile;
}

/** Request to open a file, made by the palette and served by the panel. */
export interface PendingFile {
  path: string;
  line?: number;
  nonce: number;
}

/** Write to disk made from outside — the viewer uses it to reload. */
export interface ReplacedNotice {
  paths: string[];
  nonce: number;
}

interface WorkspaceSearchState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  pending: PendingFile | null;
  requestFile: (path: string, line?: number) => void;
  replaceInOpenFile: ReplaceRegistry | null;
  registerReplaceInOpenFile: (registry: ReplaceRegistry | null) => void;
  replaced: ReplacedNotice | null;
  notifyReplaced: (paths: string[]) => void;
}

let fileNonce = 0;
let replacedNonce = 0;

/**
 * State of the workspace search (⌘P) — which now lives in the App, and not in a tab.
 *
 * The shortcut is global because the palette exists to bring what is NOT in sight:
 * tying it to the files tab would make ⌘P not respond exactly when it is
 * most useful. Since the destination (the viewer) is still inside the panel, the
 * request crosses through here, with a counter — the same idiom as the panel's
 * `pendingDiff`: whoever consumes compares the nonce and serves it once.
 */
export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
  pending: null,
  requestFile: (path, line) => {
    fileNonce += 1;
    // Closes the palette along with it: choosing a result is the answer, not a step.
    set({ pending: { path, line, nonce: fileNonce }, open: false });
  },
  replaceInOpenFile: null,
  registerReplaceInOpenFile: (registry) => set({ replaceInOpenFile: registry }),
  replaced: null,
  notifyReplaced: (paths) => {
    replacedNonce += 1;
    set({ replaced: { paths, nonce: replacedNonce } });
  },
}));
