"use client";

/**
 * O painel direito da aba de pastas: o índice do que existe, do que mudou e do
 * que aconteceu.
 *
 * Três abas — as alterações do working tree (árvore podada, só o que mudou, já
 * aberta), os arquivos do workspace (árvore completa, para achar um arquivo que
 * pode não ter mudado) e o histórico de commits. O rodapé é do painel inteiro,
 * e não de uma aba: em qual projeto se está agindo, e a branch dele, valem para
 * as três.
 *
 * Com o painel estreito, só a aba ativa mostra o nome; as outras ficam no
 * ícone. Três nomes não cabem no piso de 200px, e a ativa é a única que precisa
 * se identificar.
 *
 * Ele não abre nem exibe arquivo nenhum: só avisa o pai qual foi escolhido e
 * com que lente (a lista de alterações pede o diff; a árvore completa, o
 * conteúdo).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloudIcon,
  DownloadIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  Loader2,
  RefreshCwIcon,
  TagIcon,
  UploadIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { BranchSelector } from "@/src/components/branch-selector";
import { CreateRemoteRepoDialog } from "@/src/components/create-remote-repo-dialog";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  type GitFileStatus,
} from "@/src/components/ai/file-tree";
import {
  Commit,
  CommitContent,
  CommitFile,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
  CommitFileStatus,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitSeparator,
  CommitTimestamp,
} from "@/src/components/ai/commit";
import {
  useBranchStore,
  type BranchSyncInfo,
  type SyncResult,
} from "@/src/stores/branch-store";
import {
  getBaseName,
  joinPath,
  repoForPath,
  type CommitEntry,
  type DeletedEntry,
  type DirEntryInfo,
  type GitLogResult,
  type GitNumstatResult,
  type GitRepoEntry,
  type GitStatusEntry,
  type GitStatusResult,
  type LineStat,
  type ReaddirResult,
  type ViewerLens,
} from "@/src/lib/folders";
import { useGitRepos } from "@/src/lib/use-git-repos";

/** Modo do par de painéis — o mesmo da aba selecionada à direita. */
export type BrowserTab = "files" | "changes" | "commits";

export interface FileBrowserProps {
  folders: string[];
  onFoldersChange: (folders: string[]) => void;
  /**
   * Aba ativa. Ela não é só do índice: o painel da esquerda inteiro segue este
   * modo (árvore + um arquivo, ou lista + diffs empilhados).
   */
  tab: BrowserTab;
  onTabChange: (tab: BrowserTab) => void;
  /** Caminho do arquivo do working tree aberto, para realçar na árvore. */
  selectedPath?: string;
  /** Arquivo escolhido numa das listas; `deleted` marca o fantasma de excluído. */
  onSelectFile: (path: string, deleted: boolean, lens: ViewerLens) => void;
  /**
   * Trazer um arquivo à vista na leitura empilhada. O caminho vai RELATIVO ao
   * repo, que é como o patch nomeia os arquivos.
   */
  onReveal: (relPath: string) => void;
  /** Pedido de recarga da leitura empilhada — ela vive no outro painel. */
  onRefreshChanges: () => void;
  /** Arquivo escolhido dentro de um card de commit. */
  onOpenCommitFile: (
    repoPath: string,
    hash: string,
    path: string,
    deleted: boolean,
    lens: ViewerLens,
  ) => void;
}

// ── Regiões do log de commits (estilo VS Code) ──────────────────────────
type CommitRegionKind = "default" | "pushed" | "local";

interface CommitRegion {
  kind: CommitRegionKind;
  label: string;
}

interface CommitRow {
  divider?: CommitRegion;
  commit?: CommitEntry;
}

const REGION_STYLES: Record<CommitRegionKind, { line: string; chip: string }> =
  {
    local: {
      line: "bg-amber-500/40",
      chip: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    pushed: {
      line: "bg-emerald-500/40",
      chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    default: {
      line: "bg-border",
      chip: "border-border bg-muted text-muted-foreground",
    },
  };

/** Região de um commit: branch principal, branch atual já no remoto, ou branch atual só local. */
function commitRegion(
  commit: CommitEntry,
  info: BranchSyncInfo | undefined,
): CommitRegion | null {
  if (!info?.current) return null;
  if (info.defaultBranch && info.defaultBranch !== info.current) {
    if (commit.onDefault) return { kind: "default", label: info.defaultBranch };
    return commit.pushed
      ? { kind: "pushed", label: info.upstream ?? info.current }
      : { kind: "local", label: info.current };
  }
  return commit.pushed
    ? { kind: "pushed", label: info.upstream ?? info.current }
    : { kind: "local", label: info.current };
}

// ── Badges de refs nos cards ────────────────────────────────────────────
type RefKind = "current" | "default" | "remote" | "tag" | "head" | "other";

function classifyRef(
  ref: string,
  current: string | null | undefined,
  defaultBranch: string | null | undefined,
): { kind: RefKind; name: string } {
  if (ref.startsWith("refs/heads/")) {
    const name = ref.slice("refs/heads/".length);
    if (name === current) return { kind: "current", name };
    if (name === defaultBranch) return { kind: "default", name };
    return { kind: "head", name };
  }
  if (ref.startsWith("refs/remotes/")) {
    return { kind: "remote", name: ref.slice("refs/remotes/".length) };
  }
  if (ref.startsWith("refs/tags/")) {
    return { kind: "tag", name: ref.slice("refs/tags/".length) };
  }
  return { kind: "other", name: ref };
}

const REF_BADGE_STYLES: Record<RefKind, string> = {
  current: "border-primary/30 bg-primary/10 text-primary",
  default:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  remote: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  tag: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  head: "border-border bg-muted text-muted-foreground",
  other: "border-border bg-muted text-muted-foreground",
};

const REF_PRIORITY: Record<RefKind, number> = {
  current: 0,
  default: 1,
  remote: 2,
  tag: 3,
  head: 4,
  other: 5,
};

const MAX_BRANCH_BADGES = 3;
const MAX_TAG_BADGES = 2;

function RefBadge({ kind, name }: { kind: RefKind; name: string }) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex max-w-32 items-center gap-1 truncate rounded-full border px-1.5 py-px text-[9px] font-medium",
        REF_BADGE_STYLES[kind],
      )}
    >
      {kind === "tag" && <TagIcon className="size-2.5 shrink-0" />}
      {kind === "remote" && <CloudIcon className="size-2.5 shrink-0" />}
      {kind === "current" && <GitBranchIcon className="size-2.5 shrink-0" />}
      <span className="truncate">{name}</span>
    </span>
  );
}

function CommitRefBadges({
  refs,
  current,
  defaultBranch,
}: {
  refs: string[];
  current?: string | null;
  defaultBranch?: string | null;
}) {
  if (!refs.length) return null;
  const classified = refs.map((ref) =>
    classifyRef(ref, current, defaultBranch),
  );
  // Branches e tags em grupos independentes: tags sempre aparecem ao lado
  // das branches, sem serem descartadas pelo limite de badges de branch.
  const branches = classified
    .filter((b) => b.kind !== "tag")
    .sort((a, b) => REF_PRIORITY[a.kind] - REF_PRIORITY[b.kind]);
  const tags = classified
    .filter((b) => b.kind === "tag")
    .sort((a, b) => a.name.localeCompare(b.name));
  const visibleBranches = branches.slice(0, MAX_BRANCH_BADGES);
  const visibleTags = tags.slice(0, MAX_TAG_BADGES);
  const rest = [
    ...branches.slice(MAX_BRANCH_BADGES),
    ...tags.slice(MAX_TAG_BADGES),
  ];
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5">
      {visibleBranches.map((b) => (
        <RefBadge key={b.name} kind={b.kind} name={b.name} />
      ))}
      {visibleTags.map((b) => (
        <RefBadge key={b.name} kind={b.kind} name={b.name} />
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((b) => b.name).join(", ")}
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}

function renderEntries(
  dirPath: string,
  entries: DirEntryInfo[] | undefined,
  dirCache: Record<string, DirEntryInfo[]>,
  expandedPaths: Set<string>,
  gitStatus: Record<string, GitStatusEntry>,
  deletedByDir: Record<string, DeletedEntry[]>,
): ReactNode[] | null {
  if (!entries) return null;
  const children: ReactNode[] = entries.map((entry) =>
    entry.isDirectory ? (
      <FileTreeFolder key={entry.path} name={entry.name} path={entry.path}>
        {expandedPaths.has(entry.path) &&
          renderEntries(
            entry.path,
            dirCache[entry.path],
            dirCache,
            expandedPaths,
            gitStatus,
            deletedByDir,
          )}
      </FileTreeFolder>
    ) : (
      <FileTreeFile
        key={entry.path}
        name={entry.name}
        path={entry.path}
        status={gitStatus[entry.path]?.status}
      />
    ),
  );
  // Arquivos excluídos (não existem em disco): entram como fantasmas no
  // diretório pai, com indicador D — clicar abre o arquivo como excluído.
  const deleted = deletedByDir[dirPath];
  if (deleted) {
    for (const d of deleted) {
      children.push(
        <FileTreeFile
          key={d.path}
          name={d.name}
          path={d.path}
          status="deleted"
        />,
      );
    }
  }
  return children;
}

// ── Árvore das alterações ───────────────────────────────────────────────

interface ChangeFileNode {
  path: string;
  name: string;
  status: GitFileStatus;
  stat?: LineStat;
}

interface ChangeDirNode {
  path: string;
  name: string;
  dirs: ChangeDirNode[];
  files: ChangeFileNode[];
}

/**
 * Monta a árvore das alterações a partir do git status.
 *
 * Existem só os diretórios que contêm alguma alteração: é uma árvore podada,
 * o oposto da árvore completa da outra aba. Ali se procura um arquivo que pode
 * não ter mudado; aqui só interessa o que mudou, e cada nível de pasta só
 * existe para dar o caminho do arquivo.
 */
function buildChangeTree(
  root: string,
  files: ChangeFileNode[],
): { root: ChangeDirNode; dirPaths: string[] } {
  const base = root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const rootNode: ChangeDirNode = {
    path: base,
    name: getBaseName(root),
    dirs: [],
    files: [],
  };
  const dirs = new Map<string, ChangeDirNode>([[base, rootNode]]);

  for (const file of files) {
    const abs = file.path.replace(/\\/g, "/");
    const rel = abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
    const parts = rel.split("/").filter(Boolean);
    const name = parts.pop() ?? rel;
    let cur = rootNode;
    let curPath = base;
    for (const part of parts) {
      curPath = `${curPath}/${part}`;
      let next = dirs.get(curPath);
      if (!next) {
        next = { path: curPath, name: part, dirs: [], files: [] };
        dirs.set(curPath, next);
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push({ ...file, name });
  }

  const sortNode = (node: ChangeDirNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of node.dirs) sortNode(d);
  };
  sortNode(rootNode);

  return {
    root: rootNode,
    dirPaths: [...dirs.keys()].filter((p) => p !== base),
  };
}

/** Desenha um nível da árvore podada: pastas primeiro, depois os arquivos. */
function renderChangeEntries(
  node: ChangeDirNode,
  expanded: Set<string>,
): ReactNode[] {
  return [
    ...node.dirs.map((dir) => (
      <FileTreeFolder key={dir.path} name={dir.name} path={dir.path}>
        {expanded.has(dir.path) && renderChangeEntries(dir, expanded)}
      </FileTreeFolder>
    )),
    ...node.files.map((f) => (
      <FileTreeFile
        key={f.path}
        name={f.name}
        path={f.path}
        status={f.status}
        stat={f.stat}
      />
    )),
  ];
}

function FolderQuickSwitch({
  folders,
  onFoldersChange,
}: {
  folders: string[];
  onFoldersChange: (f: string[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const primaryName =
    folders.length === 0 ? t("folders.noFolder") : getBaseName(folders[0]);

  const handleSelectFolder = (path: string) => {
    setOpen(false);
    if (folders[0] === path) return;
    onFoldersChange([path, ...folders.filter((f) => f !== path)]);
  };

  return (
    <div
      className="relative shrink-0 border-t border-sidebar-border p-2 pt-2.5"
      ref={ref}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">{primaryName}</span>
        <ChevronUpIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("folders.associated")}
          </p>
          {folders.map((f) => (
            <button
              key={f}
              onClick={() => handleSelectFolder(f)}
              className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-left">
                {getBaseName(f)}
              </span>
              {folders[0] === f && <CheckIcon className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FileBrowser({
  folders,
  onFoldersChange,
  selectedPath,
  tab,
  onTabChange,
  onSelectFile,
  onReveal,
  onRefreshChanges,
  onOpenCommitFile,
}: FileBrowserProps) {
  const { t } = useTranslation();
  /**
   * O histórico é a terceira aba, e o log só é buscado quando ela está à vista
   * — daí ser derivado da aba, e não um estado próprio: os efeitos que dependem
   * dele continuam valendo, agora sem poder divergir do que está na tela.
   */
  const commitsOpen = tab === "commits";
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(folders),
  );
  const [dirCache, setDirCache] = useState<Record<string, DirEntryInfo[]>>({});
  const loadingRef = useRef<Set<string>>(new Set());
  const entryIsDirRef = useRef<Map<string, boolean>>(new Map());

  // ── Repositórios desta pasta de trabalho ──────────────────────────────
  // Um espaço pode ter git na própria pasta e/ou em subpastas com repo próprio
  // (`front/`, `back/`), cada uma com o seu. O painel fala com UM por vez — o
  // ativo, que o rodapé, a lista de alterações e os indicadores da árvore
  // seguem. Sem nenhum repo descoberto o caminho volta a ser a pasta raiz, que
  // é exatamente o comportamento de sempre.
  const repos = useGitRepos(folders);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  /** Seção aberta do acordeão — uma por vez: abrir outra fecha a primeira. */
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const repo = activeRepo ?? folders[0];
  // Sem repo descoberto não há acordeão: a lista da pasta de trabalho fica
  // aberta, sozinha e sem cabeçalho.
  const openPath = repos.length > 0 ? openRepo : (repo ?? null);
  // Estável de propósito: alimenta os loaders do status e do numstat, que são
  // dependência de efeito — recriar a lista a cada render viraria laço.
  const repoSections = useMemo<GitRepoEntry[]>(
    () =>
      repos.length > 0
        ? repos
        : repo
          ? [{ path: repo, name: getBaseName(repo), relative: "" }]
          : [],
    [repos, repo],
  );

  // Recarrega diretórios quando o branch git muda
  const currentBranch = useBranchStore((s) =>
    repo ? s.byDir[repo]?.current : undefined,
  );
  const branchInfo = useBranchStore((s) =>
    repo ? s.infoByDir[repo] : undefined,
  );
  // Cabeçalho de cada repo do acordeão: branch e distância do remoto saem do
  // mesmo cache por pasta que o rodapé usa.
  const branchByDir = useBranchStore((s) => s.byDir);
  const infoByDir = useBranchStore((s) => s.infoByDir);
  const syncBusyDir = useBranchStore((s) => s.syncBusyDir);
  const refreshInfo = useBranchStore((s) => s.refreshInfo);
  const pullChanges = useBranchStore((s) => s.pullChanges);
  const pushChanges = useBranchStore((s) => s.pushChanges);

  // Status git do working tree, keyed por caminho absoluto (indicadores na árvore)
  const [gitStatus, setGitStatus] = useState<Record<string, GitStatusEntry>>(
    {},
  );
  /** +N/-N por caminho ABSOLUTO — o git devolve relativo ao repo, e aqui já
   *  vem juntado com a pasta dele, igual ao status. */
  const [numstat, setNumstat] = useState<Record<string, LineStat>>({});
  const [refreshing, setRefreshing] = useState(false);

  const [commits, setCommits] = useState<CommitEntry[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsReload, setCommitsReload] = useState(0);
  const [commitsHasMore, setCommitsHasMore] = useState(false);
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false);
  // Ref de exclusão mútua síncrona (evita duas páginas simultâneas com o mesmo skip)
  const commitsLoadingMoreRef = useRef(false);
  // Época da carga inicial: descarta appends de uma página velha que chegue
  // depois de um reload (pull/push/troca de pasta).
  const commitsEpochRef = useRef(0);
  const commitsEndRef = useRef<HTMLDivElement | null>(null);

  const [syncStatus, setSyncStatus] = useState<{
    kind: "error" | "info";
    text: string;
  } | null>(null);
  const [criarRepoOpen, setCriarRepoOpen] = useState(false);

  const loadDir = useCallback(async (dirPath: string) => {
    if (loadingRef.current.has(dirPath)) return;
    loadingRef.current.add(dirPath);
    const result = (await window.ipcRenderer.invoke(
      "fs:readdir",
      dirPath,
    )) as ReaddirResult;
    loadingRef.current.delete(dirPath);
    if (result.ok) {
      for (const e of result.entries)
        entryIsDirRef.current.set(e.path, e.isDirectory);
      setDirCache((prev) => ({ ...prev, [dirPath]: result.entries }));
    }
  }, []);

  const reloadRootDir = useCallback(
    (dir: string) => {
      setDirCache((prev) => {
        if (!prev[dir]) return prev;
        const next = { ...prev };
        delete next[dir];
        return next;
      });
      loadDir(dir);
    },
    [loadDir],
  );

  // ── Status do espaço, não de um repo só ───────────────────────────────
  // A árvore e a lista de alterações mostram o ESPAÇO: num workspace com
  // `front/` e `back/`, as mudanças dos dois aparecem, cada uma debaixo do seu
  // projeto. Por isso o status é lido de todos os repos descobertos — e as
  // chaves viram caminhos ABSOLUTOS, porque duas pastas podem ter o mesmo
  // `src/index.ts` e a chave relativa colidiria.
  const loadGitStatus = useCallback(async () => {
    const map: Record<string, GitStatusEntry> = {};
    for (const target of repoSections) {
      const result = (await window.ipcRenderer.invoke(
        "git:status",
        target.path,
      )) as GitStatusResult;
      if (!result.ok) continue;
      for (const entry of result.entries) {
        map[joinPath(target.path, entry.path)] = entry;
      }
    }
    setGitStatus(map);
  }, [repoSections]);

  // Linhas por arquivo, para o "+N -N" da lista de alterações. Falha de numstat
  // não é erro de tela: sem os números a lista continua útil.
  const loadNumstat = useCallback(async () => {
    const map: Record<string, LineStat> = {};
    for (const target of repoSections) {
      const result = (await window.ipcRenderer.invoke(
        "git:workingNumstat",
        target.path,
      )) as GitNumstatResult;
      if (!result.ok) continue;
      for (const [relPath, stat] of Object.entries(result.stats)) {
        map[joinPath(target.path, relPath)] = stat;
      }
    }
    setNumstat(map);
  }, [repoSections]);

  // Recarrega os indicadores ao montar, trocar de pasta/branch, voltar às
  // listas (pull/push/disco podem ter mudado o working tree) ou pedir refresh.
  // Fechado o histórico, nada disso aparece na tela.
  useEffect(() => {
    if (commitsOpen) return;
    void loadGitStatus();
    void loadNumstat();
  }, [commitsOpen, tab, loadGitStatus, loadNumstat, currentBranch]);

  // A branch do rodapé vale para os dois modos e não pode depender de o
  // histórico ter sido aberto alguma vez — era daí que vinha o "Detached"
  // mentiroso: sem dado carregado, o rótulo caía no vazio.
  useEffect(() => {
    if (repo) void refreshInfo(repo);
  }, [repo, refreshInfo]);

  // A escolha anterior sobrevive a um refresh ou a um pull: só cai quando
  // aquele repo deixou de existir. Sem nenhum descoberto, o painel volta a
  // falar com a pasta de trabalho — o comportamento de sempre.
  useEffect(() => {
    setActiveRepo((prev) =>
      prev && repos.some((x) => x.path === prev)
        ? prev
        : (repos[0]?.path ?? null),
    );
    setOpenRepo((prev) =>
      prev && repos.some((x) => x.path === prev)
        ? prev
        : (repos[0]?.path ?? null),
    );
  }, [repos]);

  // O cabeçalho de cada repo mostra a branch dele — e isso custa alguns
  // comandos git por repo. Vale com o histórico à vista (é quando os cabeçalhos
  // existem) e com mais de um projeto, que é quando o chip do rodapé lista a
  // branch de cada um; o do repo ativo, esse, o rodapé pede o tempo todo.
  useEffect(() => {
    if (!commitsOpen && repos.length < 2) return;
    for (const r of repos) void refreshInfo(r.path);
  }, [commitsOpen, repos, refreshInfo]);

  // Acordeão exclusivo: abrir uma seção fecha a outra. Clicar na que já está
  // aberta recolhe — e o repo segue sendo o ativo do painel.
  const handleRepoClick = useCallback((path: string) => {
    setOpenRepo((prev) => (prev === path ? null : path));
    setActiveRepo(path);
  }, []);

  /**
   * Escolher em qual projeto o painel age — pelo chip do rodapé, que é onde a
   * escolha fica visível. O histórico vai junto: com a seção aberta noutro repo,
   * a lista mostraria um e o rodapé falaria de outro, e o puxar/enviar iriam
   * para o repositório errado.
   */
  const handleRepoPick = useCallback((path: string) => {
    setOpenRepo(path);
    setActiveRepo(path);
  }, []);

  /**
   * O rodapé segue o arquivo em foco: é o repo DELE que o seletor de branch e o
   * puxar/enviar alcançam — a troca de branch por pasta, como no VS Code.
   *
   * Sem isto o rodapé mudava só pelo histórico: a mesma ação (focar um arquivo)
   * trocava a branch embaixo numa aba e não na outra, que era o que não fechava.
   */
  const focusRepoOf = useCallback(
    (filePath: string) => {
      const owner = repoForPath(repoSections, filePath);
      if (owner) setActiveRepo(owner);
    },
    [repoSections],
  );

  // Agrupa arquivos excluídos por diretório pai (camada de fantasma no tree).
  const deletedByDir = useMemo(() => {
    const map: Record<string, DeletedEntry[]> = {};
    for (const [absPath, entry] of Object.entries(gitStatus)) {
      if (entry.status !== "deleted") continue;
      const idx = absPath.lastIndexOf("/");
      const dir = idx >= 0 ? absPath.slice(0, idx) : absPath;
      const name = idx >= 0 ? absPath.slice(idx + 1) : absPath;
      const list = map[dir] ?? [];
      list.push({ path: absPath, name });
      map[dir] = list;
    }
    return map;
  }, [gitStatus]);

  // ── A lista de alterações ─────────────────────────────────────────────
  const changeFiles = useMemo<ChangeFileNode[]>(
    () =>
      Object.entries(gitStatus).map(([abs, entry]) => ({
        path: abs,
        name: getBaseName(abs),
        status: entry.status,
        stat: numstat[abs],
      })),
    [gitStatus, numstat],
  );

  // Com mais de um repo a árvore nasce na pasta de trabalho, e não no repo
  // ativo: é isso que faz cada projeto virar uma pasta de primeiro nível, com
  // as alterações dele debaixo. Com um repo só, nasce nele — o caminho de
  // sempre.
  const { root: changeRoot, dirPaths: changeDirPaths } = useMemo(
    () =>
      buildChangeTree(
        repos.length > 1 ? (folders[0] ?? repo ?? "") : (repo ?? ""),
        changeFiles,
      ),
    [repos.length, folders, repo, changeFiles],
  );

  // Pastas da lista de alterações nascem TODAS abertas — é o ponto da aba: ver
  // o que mudou sem ter de abrir caminho. Guardar o que foi FECHADO (e não o
  // que foi aberto) é o que faz a pasta que a pessoa recolheu continuar
  // recolhida quando o status do git recarrega.
  const [collapsedChanges, setCollapsedChanges] = useState<Set<string>>(
    new Set(),
  );
  const changesExpanded = useMemo(() => {
    const next = new Set(changeDirPaths);
    for (const p of collapsedChanges) next.delete(p);
    return next;
  }, [changeDirPaths, collapsedChanges]);
  const handleChangesExpandedChange = useCallback(
    (next: Set<string>) => {
      setCollapsedChanges(new Set(changeDirPaths.filter((p) => !next.has(p))));
    },
    [changeDirPaths],
  );

  useEffect(() => {
    if (!currentBranch || folders.length === 0) return;
    reloadRootDir(folders[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBranch]);

  useEffect(() => {
    for (const f of folders) entryIsDirRef.current.set(f, true);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const f of folders) next.add(f);
      return next;
    });
    for (const f of folders) {
      if (!dirCache[f]) loadDir(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders]);

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      setExpandedPaths(next);
      for (const p of next) {
        if (!dirCache[p] && entryIsDirRef.current.get(p) !== false) loadDir(p);
      }
    },
    [dirCache, loadDir],
  );

  /**
   * Árvore completa: um arquivo alterado leva à leitura empilhada, na seção
   * dele. Arquivo sem alteração abre para edição — é o outro motivo de clicar
   * num arquivo, e o único que a leitura não atende.
   */
  const handleSelect = useCallback(
    (path: string) => {
      // A checagem de alterado vem antes da de diretório: um arquivo excluído
      // não está em listagem nenhuma do disco, então não teria como passar.
      if (gitStatus[path]) {
        // Vai o caminho ABSOLUTO: com mais de um repositório, o relativo não
        // diz de qual projeto é o arquivo.
        focusRepoOf(path);
        onReveal(path);
        return;
      }
      if (entryIsDirRef.current.get(path) === false) {
        focusRepoOf(path);
        onSelectFile(path, false, "content");
      }
    },
    [gitStatus, focusRepoOf, onReveal, onSelectFile],
  );

  /**
   * Lista de alterações: abrir um arquivo é querer ver O QUE MUDOU nele, então
   * a lente já vem no diff. Clique em pasta não é seleção — é só abrir/fechar.
   */
  const handleSelectChange = useCallback(
    (path: string) => {
      if (!gitStatus[path]) return;
      // Caminho absoluto, como no clique da árvore: é o que identifica o repo.
      focusRepoOf(path);
      onReveal(path);
    },
    [gitStatus, focusRepoOf, onReveal],
  );

  const handleRefresh = useCallback(async () => {
    if (!repo || refreshing) return;
    setRefreshing(true);
    try {
      // A árvore é da pasta de trabalho inteira; o status é do repo ativo.
      reloadRootDir(folders[0] ?? repo);
      onRefreshChanges();
      await Promise.all([loadGitStatus(), loadNumstat()]);
      // O botão é o único "atualizar" do painel e vale para as três abas: no
      // histórico, o que há para atualizar é o log.
      setCommitsReload((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }, [
    repo,
    folders,
    refreshing,
    reloadRootDir,
    loadGitStatus,
    loadNumstat,
    onRefreshChanges,
  ]);

  const syncErrorMessage = useCallback(
    (result: Extract<SyncResult, { ok: false }>) => {
      if (result.kind === "noRemote") return t("folders.noRemote");
      if (result.kind === "noUpstream") return t("folders.noUpstreamPull");
      if (result.kind === "auth")
        return `${t("folders.authFailed")}\n${result.message}`;
      return result.message;
    },
    [t],
  );

  const handlePull = useCallback(async () => {
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pullChanges(repo);
    if (result.ok) {
      reloadRootDir(folders[0] ?? repo);
      void loadGitStatus();
      void loadNumstat();
      setCommitsReload((n) => n + 1);
      setSyncStatus({ kind: "info", text: t("folders.pulledOk") });
    } else {
      setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
    }
  }, [
    repo,
    folders,
    syncBusyDir,
    pullChanges,
    reloadRootDir,
    loadGitStatus,
    loadNumstat,
    syncErrorMessage,
    t,
  ]);

  const handlePush = useCallback(async () => {
    if (!repo || syncBusyDir) return;
    setSyncStatus(null);
    const result = await pushChanges(repo);
    if (result.ok) {
      void loadGitStatus();
      setCommitsReload((n) => n + 1);
      setSyncStatus({
        kind: "info",
        text: result.created
          ? t("folders.pushedCreated")
          : t("folders.pushedOk"),
      });
      return;
    }
    // Sem remote não é erro do usuário, é um passo que falta: o modal oferece
    // criar o repositório em vez de só informar que não dá para enviar.
    if (result.kind === "noRemote") {
      setCriarRepoOpen(true);
      return;
    }
    setSyncStatus({ kind: "error", text: syncErrorMessage(result) });
  }, [repo, syncBusyDir, pushChanges, loadGitStatus, syncErrorMessage, t]);

  useEffect(() => {
    if (!commitsOpen || !repo) return;
    let cancelled = false;
    ++commitsEpochRef.current;
    setCommitsLoading(true);
    setCommitsError(null);
    setCommitsHasMore(false);
    setCommitsLoadingMore(false);
    commitsLoadingMoreRef.current = false;
    void refreshInfo(repo);
    window.ipcRenderer.invoke("git:log", repo).then((result) => {
      if (cancelled) return;
      const r = result as GitLogResult;
      setCommitsLoading(false);
      if (r.ok) {
        setCommits(r.commits);
        setCommitsHasMore(r.hasMore);
      } else {
        setCommits([]);
        setCommitsHasMore(false);
        setCommitsError(r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [commitsOpen, repo, commitsReload, refreshInfo]);

  const loadMoreCommits = useCallback(() => {
    if (!repo || !commits || commitsLoading || commitsHasMore === false) return;
    // commitsLoadingMore do estado não é síncrono: a ref garante exclusão mútua
    // mesmo com o IntersectionObserver disparando várias vezes no mesmo tick.
    if (commitsLoadingMoreRef.current) return;
    commitsLoadingMoreRef.current = true;
    const epoch = commitsEpochRef.current;
    setCommitsLoadingMore(true);
    void window.ipcRenderer
      .invoke("git:log", repo, commits.length)
      .then((result) => {
        if (epoch !== commitsEpochRef.current) return;
        const r = result as GitLogResult;
        if (r.ok) {
          setCommits((prev) => [...(prev ?? []), ...r.commits]);
          setCommitsHasMore(r.hasMore);
        }
      })
      .finally(() => {
        commitsLoadingMoreRef.current = false;
        setCommitsLoadingMore(false);
      });
  }, [repo, commits, commitsLoading, commitsHasMore]);

  // Sentinela no fim da lista: quando o viewport do ScrollArea se aproxima do
  // fim (rootMargin de 300px), carrega a próxima página -> scroll contínuo.
  useEffect(() => {
    const el = commitsEndRef.current;
    if (!el) return;
    const viewport = el.closest('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMoreCommits();
        }
      },
      { root: viewport, rootMargin: "300px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // `openPath` entra nas dependências porque recolher e reabrir a seção
    // remonta a sentinela: sem isso o observador continuaria preso ao nó velho
    // e o scroll infinito pararia de carregar depois do primeiro recolhimento.
  }, [commits, loadMoreCommits, openPath]);

  // Linhas do log com divisores de região (main vs branch atual vs remoto)
  const commitRows = useMemo<CommitRow[]>(() => {
    if (!commits) return [];
    const rows: CommitRow[] = [];
    let prevKey: string | null = null;
    for (const commit of commits) {
      const region = commitRegion(commit, branchInfo);
      const key = region ? `${region.kind}\u0000${region.label}` : null;
      if (region && key !== prevKey) rows.push({ divider: region });
      prevKey = key;
      rows.push({ commit });
    }
    return rows;
  }, [commits, branchInfo]);

  const changeCount = changeFiles.length;

  /**
   * O cabeçalho de um repo no acordeão: nome, branch, distância do remoto e o
   * marcador de working tree sujo.
   *
   * Com a seção aberta ele fica fixo no topo do scroll — e o padding de cima é
   * dele, não do container, justamente para que, ao grudar, o próprio
   * cabeçalho cubra a faixa por onde a lista passa.
   */
  const renderRepoHeader = (section: GitRepoEntry) => {
    const open = openPath === section.path;
    const branch = branchByDir[section.path]?.current;
    const info = infoByDir[section.path];
    return (
      <button
        type="button"
        onClick={() => handleRepoClick(section.path)}
        title={section.relative || section.name}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 pb-1.5 pt-2 text-left transition-colors",
          open ? "sticky top-0 z-10 bg-code-viewer" : "hover:bg-accent/50",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate text-xs font-medium">
          {section.name}
        </span>
        {/* Repo aninhado: o caminho desfaz a dúvida de qual "front" é este. */}
        {section.relative.includes("/") && (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            {section.relative}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {info?.dirty && (
            <span className="text-amber-500" title={t("folders.uncommitted")}>
              *
            </span>
          )}
          {branch && <span className="max-w-24 truncate">{branch}</span>}
          {(info?.ahead ?? 0) > 0 && (
            <span className="flex items-center text-emerald-500">
              <ArrowUpIcon className="size-2.5" />
              {info?.ahead}
            </span>
          )}
          {(info?.behind ?? 0) > 0 && (
            <span className="flex items-center text-rose-500">
              <ArrowDownIcon className="size-2.5" />
              {info?.behind}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="@container flex h-full min-h-0 min-w-0 flex-col bg-code-viewer rounded-lg m-1">
        <Tabs
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onValueChange={(v) => onTabChange(v as BrowserTab)}
          value={tab}
        >
          <div className="shrink-0 px-3 pt-4 ">
            {/* Três índices, e não duas listas com o histórico atrás de um botão
                no rodapé. O nome fica só na aba ativa quando o painel aperta:
                três nomes não cabem no piso de 200px, e a ativa é a única que
                precisa se identificar — as outras se explicam pelo ícone.
                Sem o nome, elas encolhem para o ícone (`flex-none`) e a sobra
                vai toda para a ativa: é o que faz o nome dela caber inteiro,
                em vez de aparecer truncado entre duas abas largas e vazias. */}
            <TabsList className="w-full">
              <TabsTrigger
                className="group min-w-0 flex-1 @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.filesTab")}
                value="files"
              >
                <FolderTreeIcon className="size-3.5 shrink-0" />
                <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                  {t("folders.filesTab")}
                </span>
              </TabsTrigger>
              <TabsTrigger
                className="group min-w-0 flex-[1.3] @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.changesTab")}
                value="changes"
              >
                <GitCompareArrowsIcon className="size-3.5 shrink-0" />
                <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                  {t("folders.changesTab")}
                </span>
                {changeCount > 0 && (
                  <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1 text-[10px] tabular-nums">
                    {changeCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                className="group min-w-0 flex-1 @max-[18rem]:flex-none @max-[18rem]:data-[active]:flex-1"
                title={t("folders.commitsTab")}
                value="commits"
              >
                <HistoryIcon className="size-3.5 shrink-0" />
                <span className="hidden min-w-0 truncate group-data-[active]:inline @[18rem]:inline">
                  {t("folders.commitsTab")}
                </span>
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            value="commits"
          >
            <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-border/60 px-2 py-1.5">
              <button
                type="button"
                onClick={() => void handlePull()}
                disabled={
                  syncBusyDir !== null ||
                  !branchInfo?.current ||
                  !branchInfo?.hasRemote
                }
                title={t("folders.pullHint")}
                className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
              >
                <DownloadIcon className="size-3" />
                <span className="hidden @[16rem]:inline">
                  {t("folders.pull")}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void handlePush()}
                disabled={syncBusyDir !== null || !branchInfo?.current}
                title={t("folders.pushHint")}
                className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-40"
              >
                {syncBusyDir ? (
                  <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <UploadIcon className="size-3" />
                )}
                <span className="hidden @[16rem]:inline">
                  {t("folders.push")}
                </span>
              </button>
            </div>
            {syncStatus && (
              <p
                className={cn(
                  "shrink-0 break-words border-b border-border/60 px-2 py-1 text-[10px] leading-snug",
                  syncStatus.kind === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {syncStatus.text}
              </p>
            )}
            {/* `min-h-0 flex-1`, e não `h-full`: esta coluna já tem a barra de
                cima e a faixa de sync acima, então `h-full` fazia o scroll pegar
                a altura INTEIRA do painel e passar por baixo do rodapé — que
                tem de ficar sempre à vista. */}
            <ScrollArea className="min-h-0 flex-1">
              {/* Sem padding em cima: o cabeçalho do repo aberto é `sticky` e
                  traz a própria folga — assim, ao grudar no topo, ele cobre a
                  faixa por onde a lista passa. */}
              {/* `mr-2`: a barra de rolagem é sobreposta à lista, e sem a folga
                  ela passava por cima do texto dos commits. */}
              <div className="mr-2 flex flex-col gap-1 pb-2 text-xs">
                {repoSections.map((section) => (
                  <section key={section.path} className="flex flex-col">
                    {/* Com um repo só não há o que escolher: a lista vem solta,
                        sem cabeçalho nenhum. */}
                    {repos.length > 1 && renderRepoHeader(section)}
                    {openPath === section.path && (
                      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
                        {commitsLoading && (
                          <div className="p-4 text-center text-muted-foreground">
                            {t("folders.loadingCommits")}
                          </div>
                        )}
                        {!commitsLoading && commitsError && (
                          <div className="p-4 text-center text-muted-foreground">
                            {t("folders.gitHistoryError")}
                          </div>
                        )}
                        {!commitsLoading &&
                          !commitsError &&
                          commits?.length === 0 && (
                            <div className="p-4 text-center text-muted-foreground">
                              {t("folders.noCommits")}
                            </div>
                          )}
                        {/* Sem as linhas enquanto a carga inicial corre: trocar
                            de repo não pode mostrar o commit do anterior. */}
                        {!commitsLoading &&
                          commitRows.map((row) =>
                            row.divider ? (
                              <div
                                key={`divider-${row.divider.kind}-${row.divider.label}`}
                                aria-hidden
                                className="flex items-center gap-2 px-1"
                              >
                                <div
                                  className={cn(
                                    "h-px flex-1",
                                    REGION_STYLES[row.divider.kind].line,
                                  )}
                                />
                                <span
                                  className={cn(
                                    "shrink-0 rounded-full border px-2 py-px text-[9px] font-medium",
                                    REGION_STYLES[row.divider.kind].chip,
                                  )}
                                >
                                  {row.divider.kind === "local"
                                    ? t("folders.localBranch", {
                                        branch: row.divider.label,
                                      })
                                    : row.divider.label}
                                </span>
                                <div
                                  className={cn(
                                    "h-px flex-1",
                                    REGION_STYLES[row.divider.kind].line,
                                  )}
                                />
                              </div>
                            ) : (
                              <Commit key={row.commit!.hash}>
                                <CommitHeader className="p-2">
                                  <CommitInfo className="min-w-0 gap-1">
                                    <HoverCard>
                                      <HoverCardTrigger
                                        delay={300}
                                        render={
                                          <CommitMessage className="line-clamp-2 cursor-default break-words text-xs leading-snug font-medium">
                                            {row.commit!.message}
                                          </CommitMessage>
                                        }
                                      />
                                      <HoverCardContent
                                        align="start"
                                        className="w-64 space-y-1.5"
                                        side="right"
                                      >
                                        <p className="font-medium leading-snug break-words">
                                          {row.commit!.message}
                                        </p>
                                        {row.commit!.body && (
                                          <p className="whitespace-pre-line break-words text-muted-foreground text-[11px] leading-relaxed">
                                            {row.commit!.body}
                                          </p>
                                        )}
                                        <div className="flex items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
                                          <CommitHash className="shrink-0 text-[10px]">
                                            {row.commit!.hash.slice(0, 7)}
                                          </CommitHash>
                                          <CommitSeparator className="shrink-0" />
                                          <span className="truncate">
                                            {row.commit!.author}
                                          </span>
                                          <CommitSeparator className="shrink-0" />
                                          <CommitTimestamp
                                            className="shrink-0 text-[10px]"
                                            date={new Date(row.commit!.date)}
                                          />
                                        </div>
                                      </HoverCardContent>
                                    </HoverCard>
                                    {/* O autor e o separador dele saem juntos quando a
                              coluna aperta: truncar só o texto deixava os dois
                              pontos colados com um vão vazio no meio. */}
                                    <CommitMetadata className="@container min-w-0 text-[10px]">
                                      <CommitHash className="shrink-0 text-[10px]">
                                        {row.commit!.hash.slice(0, 7)}
                                      </CommitHash>
                                      <span className="hidden min-w-0 items-center gap-2 @[16rem]:flex">
                                        <CommitSeparator className="shrink-0" />
                                        <span className="truncate">
                                          {row.commit!.author}
                                        </span>
                                      </span>
                                      <CommitSeparator className="shrink-0" />
                                      <CommitTimestamp
                                        className="shrink-0 text-[10px]"
                                        date={new Date(row.commit!.date)}
                                      />
                                    </CommitMetadata>
                                    <CommitRefBadges
                                      refs={row.commit!.refs}
                                      current={branchInfo?.current}
                                      defaultBranch={branchInfo?.defaultBranch}
                                    />
                                  </CommitInfo>
                                </CommitHeader>
                                {row.commit!.files.length > 0 && (
                                  <CommitContent className="p-2">
                                    <CommitFiles>
                                      {row.commit!.files.map((f) => (
                                        <CommitFile
                                          key={f.path}
                                          className="cursor-pointer text-[11px]"
                                          onClick={() =>
                                            // O que interessa num commit é o que ele mudou:
                                            // abre já no diff, com o conteúdo a um clique.
                                            onOpenCommitFile(
                                              section.path,
                                              row.commit!.hash,
                                              f.path,
                                              f.status === "deleted",
                                              "diff",
                                            )
                                          }
                                        >
                                          <CommitFileInfo>
                                            <CommitFileStatus
                                              status={f.status}
                                            />
                                            <CommitFileIcon />
                                            <CommitFilePath>
                                              {f.path}
                                            </CommitFilePath>
                                          </CommitFileInfo>
                                        </CommitFile>
                                      ))}
                                    </CommitFiles>
                                  </CommitContent>
                                )}
                              </Commit>
                            ),
                          )}
                        {!commitsLoading &&
                          !commitsError &&
                          commits !== null &&
                          commits.length > 0 && (
                            <div
                              ref={commitsEndRef}
                              className="flex min-h-6 items-center justify-center gap-2 p-1"
                            >
                              {commitsLoadingMore && (
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                              )}
                              {!commitsLoadingMore && !commitsHasMore && (
                                <span className="text-[10px] text-muted-foreground">
                                  {t("folders.historyEnd")}
                                </span>
                              )}
                            </div>
                          )}
                      </div>
                    )}
                  </section>
                ))}
                {/* Acordeão recolhido: os repos ficam à vista, sem lista. */}
                {repos.length > 1 && !openPath && (
                  <p className="px-2 py-4 text-center text-muted-foreground">
                    {t("folders.reposPick")}
                  </p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            value="changes"
          >
            {changeCount === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {t("folders.changesEmpty")}
              </div>
            ) : (
              <ScrollArea className="h-full">
                <FileTree
                  className="rounded-none border-0 bg-transparent mr-2 "
                  expanded={changesExpanded}
                  onExpandedChange={handleChangesExpandedChange}
                  onSelect={handleSelectChange}
                  selectedPath={selectedPath}
                >
                  {renderChangeEntries(changeRoot, changesExpanded)}
                </FileTree>
              </ScrollArea>
            )}
          </TabsContent>
          <TabsContent
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            value="files"
          >
            <ScrollArea className="h-full">
              <FileTree
                className="rounded-none border-0 bg-transparent mr-2 "
                expanded={expandedPaths}
                onExpandedChange={handleExpandedChange}
                onSelect={handleSelect}
                selectedPath={selectedPath}
              >
                {folders.map((folderPath) => (
                  <FileTreeFolder
                    key={folderPath}
                    name={getBaseName(folderPath)}
                    path={folderPath}
                  >
                    {expandedPaths.has(folderPath) &&
                      renderEntries(
                        folderPath,
                        dirCache[folderPath],
                        dirCache,
                        expandedPaths,
                        gitStatus,
                        deletedByDir,
                      )}
                  </FileTreeFolder>
                ))}
              </FileTree>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {/* Rodapé do painel inteiro: em qual projeto o painel age, a branch dele
            e o estado do working tree. Vale para as três abas — o histórico, que
            antes entrava por aqui, agora é uma delas. */}
        <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border px-2 py-1.5 text-xs">
          {/* Com mais de um projeto, o rodapé DIZ em qual está agindo. Sem isso,
              abrir uma seção do histórico trocava a branch aqui embaixo sem nada
              na tela explicando por quê — parecia a branch de outro repo. Com um
              repo só não há o que escolher, e o chip não aparece. */}
          {repos.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    title={t("folders.repoSwitch")}
                    className="flex h-6 min-w-0 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] transition-colors hover:bg-accent"
                  />
                }
              >
                <FolderIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-24 truncate">
                  {repo ? getBaseName(repo) : ""}
                </span>
                <ChevronUpIcon className="size-3 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-56 p-1"
                side="top"
              >
                {repos.map((item) => {
                  const info = infoByDir[item.path];
                  const branch = branchByDir[item.path]?.current;
                  const active = item.path === repo;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => handleRepoPick(item.path)}
                      title={item.relative || item.name}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        active
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-foreground/10",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {item.name}
                      </span>
                      {info?.dirty && (
                        <span
                          className="shrink-0 text-amber-500"
                          title={t("folders.uncommitted")}
                        >
                          *
                        </span>
                      )}
                      {branch && (
                        <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground">
                          {branch}
                        </span>
                      )}
                      {active && <CheckIcon className="size-3 shrink-0" />}
                    </button>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* O mesmo seletor do cabeçalho, abrindo para cima: o rodapé fica no
              fim do painel, e um dropdown para baixo sairia da janela. */}
          <BranchSelector compact repoPath={repo} side="top" />
          {branchInfo?.dirty && (
            <span
              className="shrink-0 text-amber-500"
              title={t("folders.uncommitted")}
            >
              *
            </span>
          )}
          {/* A distância até a branch principal saiu daqui. Ela não é a branch
              em que se está — é `rev-list main...HEAD`, a comparação com a
              `main` — e, colada no seletor de branch, parecia um segundo nome de
              branch (o "33 0 ⇄ main" da dúvida). O histórico já diz o mesmo, e
              melhor: os divisores de região marcam onde a branch começa, e o
              cabeçalho de cada projeto traz o ↑↓ dele. */}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title={t("folders.refresh")}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RefreshCwIcon
              className={cn("size-3.5", refreshing && "animate-spin")}
            />
          </button>
        </div>

        <FolderQuickSwitch
          folders={folders}
          onFoldersChange={onFoldersChange}
        />
      </div>
      {repo && (
        <CreateRemoteRepoDialog
          repoPath={repo}
          open={criarRepoOpen}
          onOpenChange={setCriarRepoOpen}
          onCreated={(result) => {
            setCommitsReload((n) => n + 1);
            void refreshInfo(repo);
            setSyncStatus({
              kind: result.pushed ? "info" : "error",
              text: result.pushed
                ? t("createRepo.sucesso", { repo: result.fullName })
                : t("createRepo.criadoSemPush", { repo: result.fullName }),
            });
          }}
        />
      )}
    </>
  );
}
