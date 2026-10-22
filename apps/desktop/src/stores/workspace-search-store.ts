import { create } from "zustand";

import type { WsMatchOptions } from "@/src/lib/ipc";

/** Substituição no buffer do arquivo aberto, publicada pela aba de arquivos. */
export type ReplaceInOpenFile = (
  query: string,
  replacement: string,
  options: WsMatchOptions,
) => number;

/**
 * O que a aba de arquivos publica quando há um editor de texto em foco: qual
 * arquivo é (para a paleta saber se pode oferecer "neste arquivo") e como
 * substituir no buffer dele.
 */
export interface ReplaceRegistry {
  path: string;
  run: ReplaceInOpenFile;
}

/** Pedido de abrir um arquivo, feito pela paleta e atendido pelo painel. */
export interface PendingFile {
  path: string;
  line?: number;
  nonce: number;
}

/** Gravação em disco feita por fora — o visualizador usa para recarregar. */
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
 * Estado da busca do espaço (⌘P) — que agora vive no App, e não numa aba.
 *
 * O atalho é global porque a paleta existe para trazer o que NÃO está à vista:
 * amarrá-la à aba de arquivos faria o ⌘P não responder justamente quando ele é
 * mais útil. Como o destino (o visualizador) continua dentro do painel, o
 * pedido atravessa por aqui, com um contador — o mesmo idioma do `pendingDiff`
 * do painel: quem consome compara o nonce e atende uma vez só.
 */
export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
  pending: null,
  requestFile: (path, line) => {
    fileNonce += 1;
    // Fecha a paleta junto: escolher um resultado é a resposta, não um passo.
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
