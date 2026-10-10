"use client";

/**
 * O painel esquerdo da aba de pastas: mostra UM arquivo.
 *
 * Ele é dono do estado daquilo que exibe — conteúdo, rascunho, conflito, modo
 * de markdown e a lente (conteúdo ou diff). O que vem de fora é só a referência
 * do arquivo (`file`) e o contexto do workspace; o que sai é o aviso de que há
 * rascunho não salvo, que quem troca de arquivo precisa consultar antes.
 *
 * Antes disto, o mesmo estado estava espalhado pelo componente da aba, com
 * `viewedFile` e `diffMode`/`diffPatch` como estados paralelos descrevendo a
 * mesma tela — trocar de lente era mexer em três estados de fora. Aqui o alvo
 * do visualizador é um só (`file`), e a lente é um atributo dele.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  Ellipsis,
  EyeIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  Loader2,
  PanelRightCloseIcon,
  SaveIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeEditor, type CodeEditorHandle } from "@/src/components/code-editor";
import { agentWriteFromTool } from "@/src/lib/agent-merge";
import { chatApi, fsApi } from "@/src/lib/ipc";
import { parsePatch } from "@/lib/unified-diff";
import { HighlightedDiffFile } from "@/src/components/diff-lines";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/src/components/ai/artifact";
import { MessageResponse } from "@/src/components/ai/message";
import {
  markdownImageSources,
  withResolvedImages,
} from "@/src/lib/markdown-images";
import { localImageRehypePlugins } from "@/src/lib/local-image-plugins";
import { Image } from "@/src/components/ai/image";
import {
  getBaseName,
  getBreadcrumbs,
  isImageFile,
  type DiffResult,
  type ReadFileResult,
  type ViewedFile,
  type ViewerLens,
} from "@/src/lib/folders";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Salvamento automático: preferência do painel, como as demais. */
const AUTO_SAVE_KEY = "orbit-files-auto-save";
/** Espera depois da última tecla antes do save automático. */
const AUTO_SAVE_DEBOUNCE_MS = 1000;

export interface FileViewerProps {
  /** O arquivo em foco; `null` mostra o convite para escolher um na árvore. */
  file: ViewedFile | null;
  /** Raiz do repo — base dos breadcrumbs e das leituras do git. */
  repoRoot?: string;
  /** Pastas do workspace: allowlist do save e raiz do eslint. */
  roots: string[];
  /** Avisa o pai que o rascunho passou a existir ou sumiu. Precisa ser estável. */
  onDirtyChange: (dirty: boolean) => void;
  /** A lente sobre o arquivo: o conteúdo em si ou o diff dele. */
  lens: ViewerLens;
  /** Troca de lente — os dois botões flutuantes do canto inferior direito. */
  onLensChange: (lens: ViewerLens) => void;
  /** Alterna a visibilidade do navegador de arquivos (botão do cabeçalho). */
  onToggleBrowser: () => void;
}

/**
 * Modo diff do visualizador: realça com a linguagem e só pinta o fundo.
 */
function DiffCodeView({ patch, filePath }: { patch: string; filePath: string }) {
  const { t } = useTranslation();
  const files = useMemo(() => parsePatch(patch), [patch]);

  if (files.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("folders.noChangesInDiff")}
      </div>
    );
  }

  return (
    <div className="min-w-0 font-mono text-xs">
      {files.map((file, fi) => (
        <HighlightedDiffFile key={fi} file={file} filePath={filePath} />
      ))}
    </div>
  );
}

export function FileViewer({
  file,
  repoRoot,
  roots,
  lens,
  onDirtyChange,
  onLensChange,
  onToggleBrowser,
}: FileViewerProps) {
  const { t } = useTranslation();

  const [content, setContent] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(file != null);
  /** mtime de quando o arquivo foi aberto — referência do save contra
   *  escrita concorrente (agente, outro editor). */
  const [mtime, setMtime] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Motivo pelo qual o último save ou a última escrita do agente não passou. */
  const [conflict, setConflict] = useState<
    null | { kind: "stale" } | { kind: "agent" } | { kind: "failed"; message: string }
  >(null);
  const [autoSave, setAutoSave] = useState(
    () => localStorage.getItem(AUTO_SAVE_KEY) === "true",
  );
  const [copied, setCopied] = useState(false);
  const [mdMode, setMdMode] = useState<"source" | "preview">("preview");
  /** Patch da lente de diff — o único dado que ela carrega do git. */
  const [patch, setPatch] = useState<string | null>(null);
  // Abrir direto no diff (é o que a lista de alterações pede) já nasce
  // carregando: sem isso o painel pisca vazio antes de o patch chegar.
  const [patchLoading, setPatchLoading] = useState(
    file != null && lens === "diff",
  );
  const [patchError, setPatchError] = useState<string | null>(null);
  /** Figuras do Markdown aberto, resolvidas contra a pasta DELE. */
  const [previewImages, setPreviewImages] = useState<Record<string, string>>({});

  const editorRef = useRef<CodeEditorHandle>(null);
  const autoSaveTimer = useRef<number>();
  const copyTimeoutRef = useRef<number>();

  /**
   * `repoRoot`, `t` e `onDirtyChange` entram por ref dentro dos efeitos: são
   * contexto, não o alvo do visualizador. Como dependência, trocar de idioma ou
   * de pasta raiz recarregaria o arquivo por cima de um rascunho em edição.
   */
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;
  const tRef = useRef(t);
  tRef.current = t;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  /** Trocar de arquivo joga fora tudo o que era do anterior. */
  const resetEditorState = useCallback(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    setImage(null);
    setMtime(null);
    setDirty(false);
    setConflict(null);
    setMdMode("preview");
    setPatch(null);
    setPatchError(null);
    setPreviewImages({});
  }, []);

  // Sair de cena (troca de aba) leva o rascunho junto — o pai não pode
  // continuar achando que há algo a descartar depois disso.
  useEffect(() => () => onDirtyChangeRef.current(false), []);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    resetEditorState();
    onDirtyChangeRef.current(false);

    const read = async () => {
      const root = repoRootRef.current;
      const tr = tRef.current;

      if (file.kind === "commit") {
        if (isImageFile(file.path)) {
          if (cancelled) return;
          setLoading(false);
          setError(tr("folders.imageNotAvailable"));
          return;
        }
        const result = (await window.ipcRenderer.invoke(
          "git:showFile",
          file.repoPath,
          file.hash,
          file.path,
          file.deleted,
        )) as ReadFileResult;
        if (cancelled) return;
        setLoading(false);
        if ("content" in result) setContent(result.content);
        else setError(result.error);
        return;
      }

      if (isImageFile(file.path)) {
        if (file.deleted) {
          if (cancelled) return;
          setLoading(false);
          setError(tr("folders.imageNotAvailable"));
          return;
        }
        const result = (await window.ipcRenderer.invoke(
          "fs:readFileAsDataUrl",
          file.path,
        )) as { dataUrl: string } | { error: string };
        if (cancelled) return;
        setLoading(false);
        if ("dataUrl" in result) setImage(result.dataUrl);
        else setError(result.error);
        return;
      }

      if (file.deleted) {
        // Arquivo excluído no working tree: o modo padrão mostra o conteúdo
        // no HEAD (o arquivo não existe mais em disco).
        if (root && file.relPath) {
          const result = (await window.ipcRenderer.invoke(
            "git:showFile",
            root,
            "HEAD",
            file.relPath,
            false,
          )) as ReadFileResult;
          if (cancelled) return;
          setLoading(false);
          if ("content" in result) setContent(result.content);
          else setError(result.error);
        } else {
          setLoading(false);
          setError(tr("folders.diffUnavailable"));
        }
        return;
      }

      const result = (await window.ipcRenderer.invoke(
        "fs:readFile",
        file.path,
      )) as ReadFileResult;
      if (cancelled) return;
      setLoading(false);
      if ("content" in result) {
        setContent(result.content);
        setMtime(result.mtimeMs ?? null);
      } else setError(result.error);
    };

    void read();
    return () => {
      cancelled = true;
    };
  }, [file, resetEditorState]);

  const isMarkdownFile = file ? /(?:\.md|\.markdown)$/i.test(file.path) : false;
  const isImage = file ? isImageFile(file.path) : false;

  /**
   * Figuras do Markdown aberto, resolvidas contra a pasta DELE.
   *
   * O preview roda na origem do app, então um `./imagens/x.png` não resolve
   * contra o arquivo e a imagem aparecia quebrada. Quem sabe a pasta é o main,
   * que devolve cada caminho como data URL.
   */
  useEffect(() => {
    if (!content || !file || !isMarkdownFile || mdMode !== "preview") {
      setPreviewImages({});
      return;
    }
    const sources = markdownImageSources(content);
    if (sources.length === 0) {
      setPreviewImages({});
      return;
    }
    // No arquivo de commit o caminho é relativo ao repositório; juntar com "/"
    // basta, porque o main resolve com path.resolve.
    const base =
      file.kind === "live" ? file.path : `${file.repoPath}/${file.path}`;
    let cancelled = false;
    window.ipcRenderer
      .invoke("fs:markdownImages", base, sources)
      .then((map) => {
        if (!cancelled) setPreviewImages(map as Record<string, string>);
      })
      .catch(() => {
        // figura é enfeite: falhar aqui não pode derrubar a leitura do texto
      });
    return () => {
      cancelled = true;
    };
  }, [content, file, isMarkdownFile, mdMode]);

  const previewMarkdown = useMemo(
    () => (content ? withResolvedImages(content, previewImages) : ""),
    [content, previewImages],
  );

  /** O galho que renderiza o CodeEditor — quem rola é ele, não o pai. */
  const showsEditor =
    !loading &&
    lens === "content" &&
    !error &&
    image == null &&
    content != null &&
    !(isMarkdownFile && mdMode === "preview");

  /**
   * Só arquivo do working tree é editável: o de um commit é histórico, e o
   * excluído não existe mais em disco.
   */
  const canEdit =
    file?.kind === "live" &&
    !file.deleted &&
    !isImage &&
    lens === "content" &&
    roots.length > 0;

  const saveFile = useCallback(
    async (next: string) => {
      if (!file || file.kind !== "live") return;
      setSaving(true);
      const result = await fsApi.writeFile({
        filePath: file.path,
        content: next,
        roots,
        expectedMtimeMs: mtime ?? undefined,
      });
      setSaving(false);
      if (result.ok) {
        setConflict(null);
        setMtime(result.mtimeMs);
        // Vira a nova base do editor: o buffer passa a espelhar o disco e o
        // indicador de rascunho apaga.
        setContent(next);
        return;
      }
      if (result.reason === "stale") {
        // Alguém escreveu no meio. Não sobrescreve nada: mostra o aviso e
        // deixa a pessoa escolher entre recarregar e insistir.
        setConflict({ kind: "stale" });
        return;
      }
      setConflict({
        kind: "failed",
        message: t(`folders.saveError.${result.reason}`, {
          defaultValue:
            "error" in result ? (result.error ?? result.reason) : result.reason,
        }),
      });
    },
    [file, roots, mtime, t],
  );

  /** Descarta o rascunho e traz o que está em disco. */
  const reloadFromDisk = useCallback(async () => {
    if (!file || file.kind !== "live") return;
    const result = (await window.ipcRenderer.invoke(
      "fs:readFile",
      file.path,
    )) as ReadFileResult;
    if ("content" in result) {
      setContent(result.content);
      setMtime(result.mtimeMs ?? null);
      setConflict(null);
    }
  }, [file]);

  /** Grava por cima, aceitando perder o que mudou em disco. */
  const overwrite = useCallback(async () => {
    const next = editorRef.current?.getContent();
    if (next == null || !file || file.kind !== "live") return;
    setSaving(true);
    const result = await fsApi.writeFile({
      filePath: file.path,
      content: next,
      roots,
    });
    setSaving(false);
    if (result.ok) {
      setConflict(null);
      setMtime(result.mtimeMs);
      setContent(next);
    }
  }, [file, roots]);

  /** Relê só o mtime, sem tocar no buffer — o conteúdo já foi fundido. */
  const reloadMtime = useCallback(async (filePath: string) => {
    const result = (await window.ipcRenderer.invoke(
      "fs:readFile",
      filePath,
    )) as ReadFileResult;
    if ("content" in result) setMtime(result.mtimeMs ?? null);
  }, []);

  /**
   * Escrita do agente no arquivo aberto.
   *
   * O evento `part` do chat já traz o input da tool, então dá para fundir a
   * alteração no buffer em vez de recarregar por cima — cursor, seleção,
   * scroll, undo e o rascunho em outras partes do arquivo sobrevivem.
   *
   * `bash` é ponto cego conhecido: escreve arquivo e não diz qual. Para esses
   * casos o que protege é a checagem de mtime no save.
   */
  useEffect(() => {
    const current = file;
    if (!current || current.kind !== "live") return;
    const open = current.path.replace(/\\/g, "/");
    return chatApi.onEvent((event) => {
      if (event.type !== "part" || event.part.type !== "tool") return;
      // Só depois de gravado: 'running' ainda não escreveu em disco, e fundir
      // ali deixaria o buffer adiantado em relação ao arquivo.
      if (event.part.state !== "done") return;
      const parsed = agentWriteFromTool(event.part.tool, event.part.input);
      if (!parsed) return;
      // O caminho da tool pode vir relativo à pasta de trabalho.
      const target = parsed.filePath.replace(/\\/g, "/");
      if (open !== target && !open.endsWith(`/${target}`)) return;
      const outcome = editorRef.current?.applyAgentWrite(parsed.write);
      if (!outcome) return;
      if (outcome.kind === "conflict") {
        setConflict({ kind: "agent" });
        return;
      }
      // O disco mudou: sem renovar o mtime, o próximo save seria recusado por
      // desatualizado mesmo já tendo incorporado a alteração do agente.
      void reloadMtime(current.path);
      if (outcome.wasClean) setContent(outcome.content);
    });
  }, [file, reloadMtime]);

  /**
   * O rascunho do editor sobe para quem troca de arquivo.
   *
   * O aviso `dirty` é do visualizador (é ele que mostra o ponto ao lado do
   * caminho), mas quem decide se pode jogar o buffer fora é a aba. Sem esta
   * ponte, a troca de arquivo descartaria o texto sem perguntar nada.
   */
  const handleEditorDirty = useCallback(
    (next: boolean) => {
      setDirty(next);
      onDirtyChange(next);
    },
    [onDirtyChange],
  );

  /** Digitação no editor — só serve ao salvamento automático. */
  const handleEditorChange = useCallback(
    (next: string) => {
      window.clearTimeout(autoSaveTimer.current);
      if (!autoSave || !canEdit) return;
      autoSaveTimer.current = window.setTimeout(() => {
        void saveFile(next);
      }, AUTO_SAVE_DEBOUNCE_MS);
    },
    [autoSave, canEdit, saveFile],
  );

  // Trocar de arquivo com save automático pendente gravaria o texto de um
  // arquivo dentro do outro.
  useEffect(() => {
    return () => window.clearTimeout(autoSaveTimer.current);
  }, [file]);

  const toggleAutoSave = useCallback(() => {
    setAutoSave((prev) => {
      const next = !prev;
      localStorage.setItem(AUTO_SAVE_KEY, String(next));
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleCopyPath = useCallback(async () => {
    if (!file) return;
    await navigator.clipboard.writeText(file.path);
  }, [file]);

  const handleReveal = useCallback(() => {
    if (file?.kind !== "live") return;
    window.ipcRenderer
      .invoke("shell:showItemInFolder", file.path)
      .catch(console.error);
  }, [file]);

  /**
   * Busca o patch da lente de diff, conforme a origem — working tree contra o
   * HEAD, ou o arquivo dentro de um commit.
   */
  const loadPatch = useCallback(async (target: ViewedFile) => {
    const tr = tRef.current;
    const root = repoRootRef.current;
    setPatchLoading(true);
    setPatchError(null);
    try {
      const result: DiffResult =
        target.kind === "live"
          ? target.relPath && root
            ? ((await window.ipcRenderer.invoke(
                "git:diffWorkingFile",
                root,
                target.relPath,
              )) as DiffResult)
            : { ok: false, error: tr("folders.diffUnavailable") }
          : ((await window.ipcRenderer.invoke(
              "git:showCommitDiff",
              target.repoPath,
              target.hash,
              target.path,
            )) as DiffResult);
      if (result.ok) setPatch(result.patch);
      else setPatchError(result.error);
    } finally {
      setPatchLoading(false);
    }
  }, []);

  /**
   * O patch acompanha a lente: entrar no diff carrega, voltar ao conteúdo
   * descarta. Assim a próxima entrada busca de novo, em vez de mostrar um diff
   * que pode ter ficado velho desde a última vez.
   */
  useEffect(() => {
    if (!file) return;
    if (lens === "content") {
      setPatch(null);
      setPatchError(null);
      return;
    }
    void loadPatch(file);
  }, [file, lens, loadPatch]);

  /**
   * Troca de lente. A escolha é do pai — é ele que decide com que lente um
   * arquivo abre —, então aqui só se guarda enquanto arquivo ou patch carregam.
   */
  const selectLens = useCallback(
    (next: ViewerLens) => {
      if (!file || loading || patchLoading) return;
      onLensChange(next);
    },
    [file, loading, patchLoading, onLensChange],
  );

  useEffect(() => () => window.clearTimeout(copyTimeoutRef.current), []);

  return (
    <Artifact className="h-full min-w-0 rounded-none border-0 bg-sidebar mt-2">
      <ArtifactHeader className="min-w-0 bg-sidebar">
        <div className="min-w-0">
          {file ? (
            <>
              {file.kind === "commit" && (
                <ArtifactTitle className="flex items-center gap-1.5 truncate">
                  <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {file.hash.slice(0, 7)}
                </ArtifactTitle>
              )}
              <ArtifactDescription className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">
                  {getBreadcrumbs(repoRoot ?? "", file.path).map((part, i, arr) => (
                    <span key={i}>
                      {i > 0 && (
                        <span className="mx-0.5 text-muted-foreground/50">›</span>
                      )}
                      <span
                        className={cn(
                          i === arr.length - 1 && "font-medium text-foreground",
                        )}
                      >
                        {part}
                      </span>
                    </span>
                  ))}
                </span>
                {dirty && (
                  <span
                    title={t("folders.unsaved")}
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                )}
                {saving && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                )}
              </ArtifactDescription>
            </>
          ) : (
            <ArtifactTitle className="flex items-center gap-1.5 truncate">
              <FolderTreeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              {t("folders.explorer")}
            </ArtifactTitle>
          )}
        </div>
        <ArtifactActions>
          <ArtifactAction
            icon={PanelRightCloseIcon}
            onClick={onToggleBrowser}
          />
          {file && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                <Ellipsis className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem onClick={handleCopyPath}>
                  <CopyIcon className="size-4" />
                  {t("folders.copyPath")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCopy} disabled={isImage}>
                  {copied ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {t("folders.copyContent")}
                </DropdownMenuItem>
                {canEdit && (
                  <DropdownMenuItem onClick={toggleAutoSave}>
                    {autoSave ? (
                      <CheckIcon className="size-4" />
                    ) : (
                      <SaveIcon className="size-4" />
                    )}
                    {t("folders.autoSave")}
                  </DropdownMenuItem>
                )}
                {file.kind === "live" && (
                  <DropdownMenuItem onClick={handleReveal}>
                    <FolderOpenIcon className="size-4" />
                    {t("folders.reveal")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ArtifactActions>
      </ArtifactHeader>
      {file ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex flex-col items-end gap-1.5 [&>*]:pointer-events-auto">
            {!isImage && (
              <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
                <button
                  type="button"
                  onClick={() => selectLens("content")}
                  title={t("folders.standardMode")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full transition-colors",
                    lens === "content"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <FileTextIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => selectLens("diff")}
                  title={t("folders.diffMode")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full transition-colors",
                    lens === "diff"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {patchLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <GitCompareArrowsIcon className="size-3.5" />
                  )}
                </button>
              </div>
            )}
            {isMarkdownFile && lens === "content" && (
              <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
                <button
                  type="button"
                  onClick={() => setMdMode("source")}
                  title={t("folders.sourceMode")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full transition-colors",
                    mdMode === "source"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <CodeIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setMdMode("preview")}
                  title={t("folders.previewMode")}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full transition-colors",
                    mdMode === "preview"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <EyeIcon className="size-3.5" />
                </button>
              </div>
            )}
          </div>
          {conflict && (
            <div className="z-20 flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
              <span className="flex-1 min-w-40">
                {conflict.kind === "stale"
                  ? t("folders.conflictStale")
                  : conflict.kind === "agent"
                    ? t("folders.conflictAgent")
                    : conflict.message}
              </span>
              {conflict.kind !== "failed" && (
                <>
                  <button
                    type="button"
                    onClick={() => void reloadFromDisk()}
                    className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                  >
                    {t("folders.conflictReload")}
                  </button>
                  {conflict.kind === "stale" && (
                    <button
                      type="button"
                      onClick={() => void overwrite()}
                      className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                    >
                      {t("folders.conflictOverwrite")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConflict(null)}
                    className="rounded-md px-1.5 py-0.5 font-medium hover:bg-amber-500/20"
                  >
                    {t("folders.conflictKeepMine")}
                  </button>
                </>
              )}
            </div>
          )}
          <ArtifactContent
            className={cn(
              "min-h-0 min-w-0 flex-1 p-0",
              // O editor rola por dentro (e só materializa as linhas
              // visíveis); os outros modos continuam rolando no pai.
              showsEditor ? "overflow-hidden" : "overflow-auto",
            )}
          >
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : lens === "diff" ? (
              patchLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {t("common.loading")}
                </div>
              ) : patchError ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {patchError}
                </div>
              ) : patch != null ? (
                <DiffCodeView patch={patch} filePath={file.path} />
              ) : null
            ) : error ? (
              <div className="p-4 text-sm text-muted-foreground">{error}</div>
            ) : image != null ? (
              <div className="flex min-w-0 items-start justify-center p-4">
                <Image src={image} alt={getBaseName(file.path)} />
              </div>
            ) : content != null ? (
              isMarkdownFile && mdMode === "preview" ? (
                <div className="min-w-0 px-4 py-4 text-sm text-foreground">
                  {/* O pipeline padrão descarta `src` em data URL, que é
                      o que a figura local vira depois de resolvida. */}
                  <MessageResponse rehypePlugins={localImageRehypePlugins}>
                    {previewMarkdown}
                  </MessageResponse>
                </div>
              ) : (
                <CodeEditor
                  ref={editorRef}
                  content={content}
                  filePath={file.path}
                  wrap={isMarkdownFile}
                  editable={canEdit}
                  workspaceRoot={repoRoot}
                  onSave={saveFile}
                  onDirtyChange={handleEditorDirty}
                  onChange={handleEditorChange}
                />
              )
            ) : null}
          </ArtifactContent>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <FolderTreeIcon className="size-16 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground">
            {t("folders.selectFileHint")}
          </p>
        </div>
      )}
    </Artifact>
  );
}
