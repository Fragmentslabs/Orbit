"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDownIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  Loader2,
} from "lucide-react";
import { parsePatch, type FileDiff } from "@/lib/unified-diff";
import { HighlightedDiffFile } from "@/src/components/diff-lines";
import {
  Artifact,
  ArtifactActions,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/src/components/ai/artifact";
import { cn } from "@/lib/utils";
import {
  getBaseName,
  joinPath,
  type GitRepoEntry,
  type GitWorkingDiffResult,
} from "@/src/lib/folders";

/** Pedido de foco num arquivo: o `nonce` faz o mesmo arquivo valer de novo. */
export interface RevealRequest {
  /**
   * O arquivo pedido. Chega ABSOLUTO quando vem do índice do painel (é o que
   * não deixa dúvida com vários repos) e relativo ao repo quando o patch é quem
   * nomeia — os dois casos são resolvidos aqui.
   */
  path: string;
  /** Muda a cada clique: sem isso, clicar de novo no mesmo arquivo não faria nada. */
  nonce: number;
}

export interface ChangesViewProps {
  /** Repositórios do espaço: a raiz quando é repo e/ou as subpastas com git. */
  repos: GitRepoEntry[];
  /** Pasta de trabalho — usada só quando nenhum repo foi descoberto. */
  repoRoot: string;
  /** Arquivo a trazer para a vista (clique no índice à direita). */
  reveal: RevealRequest | null;
  /** Abrir o arquivo no editor — esta visão só lê. Recebe caminho absoluto. */
  onOpenFile: (path: string) => void;
  /** Muda quando o rodapé manda recarregar. */
  reloadToken?: number;
}

/**
 * Altura de uma linha do diff — `leading-5` em diff-lines.tsx.
 *
 * Isto não é estética: é o que permite saber onde está uma seção que ainda não
 * foi desenhada. O miolo só monta quando chega perto da vista, então o que
 * está fora dela é espaço reservado; se a conta da altura errasse, clicar num
 * arquivo cairia longe dele. Por isso a leitura empilhada NÃO quebra linha —
 * quebrar tornaria a altura de cada linha imprevisível, e a conta, chute.
 */
const LINE_PX = 20;
/** Cabeçalho do hunk: `px-4 py-1` mais `text-[11px]` com entrelinha 1.5. */
const HUNK_PX = 24.5;
/**
 * Teto de linhas desenhadas por arquivo.
 *
 * O maior diff deste repositório tem 1.859 linhas. Sem teto, chegar nele monta
 * ~7 mil elementos e duas tokenizações gigantes de uma vez — a aba engasga
 * exatamente no arquivo que a pessoa mais quer ler. O resto fica a um clique.
 */
const MAX_LINES_PER_FILE = 400;

function countLines(file: FileDiff): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}

/**
 * Corta o arquivo no teto de linhas, preservando a numeração.
 *
 * O corte é por linha, não por hunk: um hunk pode ser cortado no meio, e como
 * o renderizador conta a numeração a partir do início do hunk, os números
 * continuam certos.
 */
function truncateDiff(
  file: FileDiff,
  max: number,
): { body: FileDiff; hidden: number } {
  let budget = max;
  const hunks: FileDiff["hunks"] = [];
  for (const hunk of file.hunks) {
    if (budget <= 1) break;
    const lines = hunk.lines.slice(0, budget - 1);
    hunks.push({ ...hunk, lines });
    budget -= 1 + lines.length;
  }
  const shown = hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  return { body: { ...file, hunks }, hidden: countLines(file) - shown };
}

/** Altura que a seção vai ter quando montar — sem montar. */
function heightOf(body: FileDiff): number {
  return countLines(body) * LINE_PX + body.hunks.length * HUNK_PX;
}

/** Chave de uma seção: o mesmo caminho pode existir em dois repositórios. */
function sectionKey(repoPath: string, filePath: string): string {
  return `${repoPath}::${filePath}`;
}

interface DiffSectionProps {
  file: FileDiff;
  /** Chave da seção (repo + caminho) — o que o observer e o scroll usam. */
  id: string;
  open: boolean;
  /** Miolo montado? Fora da vista, só a altura reservada. */
  active: boolean;
  flash: boolean;
  showAll: boolean;
  /** Registra o espaço reservado para o observer da vista. */
  observe: (el: HTMLElement | null) => void;
  /** Ref da seção inteira, para o scroll do "ir para o arquivo". */
  sectionRef: (el: HTMLElement | null) => void;
  onToggle: () => void;
  onShowAll: () => void;
  onOpenFile: () => void;
}

function DiffSection({
  file,
  id,
  open,
  active,
  flash,
  showAll,
  observe,
  sectionRef,
  onToggle,
  onShowAll,
  onOpenFile,
}: DiffSectionProps) {
  const { t } = useTranslation();
  const { body, hidden } = useMemo(
    () =>
      showAll
        ? { body: file, hidden: 0 }
        : truncateDiff(file, MAX_LINES_PER_FILE),
    [file, showAll],
  );
  const label =
    file.oldPath === file.newPath
      ? file.newPath
      : `${file.oldPath} → ${file.newPath}`;

  return (
    <section
      ref={sectionRef}
      className={cn(
        "mb-2 overflow-hidden rounded-md border transition-colors",
        flash ? "border-primary/60 ring-1 ring-primary/30" : "border-border/50",
      )}
    >
      <div className="flex items-center gap-1 bg-muted/40 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/40"
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            title={label}
          >
            {label}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] tabular-nums">
            {file.added > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{file.added}
              </span>
            )}
            {file.removed > 0 && (
              <span className="text-red-600 dark:text-red-400">
                -{file.removed}
              </span>
            )}
          </span>
        </button>
        {/* A lista à direita leva ao diff, não ao arquivo. Sem esta porta, um
            arquivo alterado ficaria impossível de abrir para editar. */}
        <button
          type="button"
          onClick={onOpenFile}
          title={t("folders.openFile")}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileCode2Icon className="size-3.5" />
        </button>
      </div>

      {open &&
        (active ? (
          <>
            <div className="min-w-0 overflow-x-auto border-t border-border/50">
              {/* min-w-max: a linha não quebra, então o bloco cresce até a
                  linha mais longa e o scroll horizontal aparece — é o que
                  mantém a altura de cada linha em exatamente LINE_PX. */}
              <div className="min-w-max font-mono text-xs">
                <HighlightedDiffFile
                  file={body}
                  wrap={false}
                  stickyHeader={false}
                />
              </div>
            </div>
            {hidden > 0 && (
              <button
                type="button"
                onClick={onShowAll}
                className="w-full border-t border-border/50 bg-muted/30 px-3 py-1.5 text-center text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                {t("folders.showMoreLines", { count: hidden })}
              </button>
            )}
          </>
        ) : (
          <div
            ref={observe}
            data-diff-path={id}
            style={{ height: heightOf(body) }}
            className="border-t border-border/50"
          />
        ))}
    </section>
  );
}

/**
 * A leitura das alterações do working tree: todos os arquivos empilhados, um
 * abaixo do outro, como a aba de diff sempre foi.
 *
 * O que mudou aqui foi o custo. Montar tudo de uma vez disparava uma
 * tokenização do Shiki por lado de cada arquivo — ~100 de uma vez, num diff
 * de 8 mil linhas. Agora o cabeçalho de cada arquivo (que é o índice da
 * leitura) aparece sempre, e o miolo monta quando chega perto da vista: o
 * Shiki roda só no que está sendo olhado, e a aba abre instantânea.
 *
 * E o que mudou depois foi o alcance: num espaço com mais de um repositório
 * (`front/` e `back/`, cada um com o seu git) a leitura não é de um repo só —
 * é do espaço inteiro, com os arquivos de cada projeto debaixo do nome dele.
 * Antes disso a aba tentava ler o diff da pasta raiz, que não é repo, e o que
 * aparecia era o erro do git.
 */
export function ChangesView({
  repos,
  repoRoot,
  reveal,
  onOpenFile,
  reloadToken = 0,
}: ChangesViewProps) {
  const { t } = useTranslation();

  // Um repo só (o caso comum) não ganha cabeçalho: a lista vem solta, como
  // sempre veio. Sem nenhum repo descoberto, a leitura é da pasta de trabalho.
  const list = useMemo<GitRepoEntry[]>(
    () =>
      repos.length > 0
        ? repos
        : repoRoot
          ? [{ path: repoRoot, name: getBaseName(repoRoot), relative: "" }]
          : [],
    [repos, repoRoot],
  );
  const grouped = list.length > 1;

  const [patches, setPatches] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  /** Seções com o miolo montado. Só cresce: remontar ao rolar de volta
   *  refaria a tokenização que acabou de ser paga. */
  const [active, setActive] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const lastReveal = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const nextPatches: Record<string, string> = {};
      const nextErrors: Record<string, string> = {};
      // Em série de propósito: são N processos git, e um espaço com vários
      // repos não deve disparar todos de uma vez.
      for (const repo of list) {
        const result = (await window.ipcRenderer.invoke(
          "git:workingDiff",
          repo.path,
        )) as GitWorkingDiffResult;
        if (result.ok) nextPatches[repo.path] = result.patch;
        else nextErrors[repo.path] = result.error;
      }
      if (cancelled) return;
      setPatches(nextPatches);
      setErrors(nextErrors);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list, reloadToken]);

  /** O diff de cada projeto, já separado e com os totais dele. */
  const groups = useMemo(
    () =>
      list.map((repo) => {
        const patch = patches[repo.path];
        const files =
          patch == null
            ? []
            : parsePatch(patch).sort((a, b) =>
                a.newPath.localeCompare(b.newPath),
              );
        const totals = files.reduce(
          (acc, file) => ({
            added: acc.added + file.added,
            removed: acc.removed + file.removed,
          }),
          { added: 0, removed: 0 },
        );
        return { repo, files, totals, error: errors[repo.path] ?? null };
      }),
    [list, patches, errors],
  );

  const totals = useMemo(
    () =>
      groups.reduce(
        (acc, group) => ({
          added: acc.added + group.totals.added,
          removed: acc.removed + group.totals.removed,
        }),
        { added: 0, removed: 0 },
      ),
    [groups],
  );
  const changeCount = useMemo(
    () => groups.reduce((total, group) => total + group.files.length, 0),
    [groups],
  );

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setActive((prev) => {
          let next: Set<string> | null = null;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const path = (entry.target as HTMLElement).dataset.diffPath;
            if (!path || prev.has(path)) continue;
            next ??= new Set(prev);
            next.add(path);
          }
          return next ?? prev;
        });
      },
      // Uma tela de folga: quando a seção entra na vista, o miolo já chegou.
      { rootMargin: "1200px 0px" },
    );
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    observerRef.current?.observe(el);
  }, []);

  /** Traz o arquivo pedido à vista: abre a seção, monta o miolo e rola até ela. */
  useEffect(() => {
    if (!reveal || loading) return;
    if (lastReveal.current === reveal.nonce) return;

    // O caminho chega absoluto (índice do painel) ou relativo ao repo (patch).
    // Com vários repos só o absoluto não deixa dúvida — o relativo casa no
    // primeiro projeto que tiver aquele arquivo.
    const wanted = reveal.path.replace(/\\/g, "/");
    let key: string | null = null;
    // O repo que casa é o de caminho MAIS LONGO: a raiz é prefixo de todo repo
    // aninhado, e ficar com o primeiro casaria o arquivo do `front/` com a raiz.
    let best = -1;
    for (const group of groups) {
      const root = group.repo.path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      if (!wanted.startsWith(root + "/") || root.length <= best) continue;
      best = root.length;
      key = sectionKey(group.repo.path, wanted.slice(root.length + 1));
    }
    if (!key) {
      for (const group of groups) {
        if (group.files.some((file) => file.newPath === wanted)) {
          key = sectionKey(group.repo.path, wanted);
          break;
        }
      }
    }
    if (!key) return;
    lastReveal.current = reveal.nonce;

    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setActive((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setFlash(key);

    // A rolagem espera o layout: a seção pode ter acabado de ser reaberta, e
    // as de cima estão no lugar certo porque o espaço reservado tem a altura
    // que o miolo vai ter.
    const frame = window.requestAnimationFrame(() => {
      sections.current
        .get(key)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reveal, groups, loading]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const markShowAll = useCallback((key: string) => {
    setShowAll((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  return (
    // Mesmo cabeçalho e mesmas margens da aba Arquivos (`file-viewer.tsx`): é o
    // mesmo painel em dois modos, e alternar entre eles não pode deslocar o topo
    // nem trocar a cor da faixa.
    <Artifact className="h-full min-w-0 rounded-none border-0 bg-sidebar mt-2">
      <ArtifactHeader className="min-w-0 bg-sidebar justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitCompareArrowsIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <ArtifactTitle className="truncate">
            {t("folders.changesTab")}
          </ArtifactTitle>
        </div>
        <ArtifactActions className="gap-3">
          {changeCount > 0 && (
            <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
              <span className="text-muted-foreground">
                {t("folders.changesCount", { count: changeCount })}
              </span>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{totals.added}
              </span>
              <span className="text-red-600 dark:text-red-400">
                -{totals.removed}
              </span>
            </span>
          )}
        </ArtifactActions>
      </ArtifactHeader>

      {/* `p-3` dos quatro lados: sem a folga de cima, o primeiro arquivo da
          leitura ficava colado no cabeçalho. */}
      <ArtifactContent className="min-h-0 min-w-0 overflow-hidden p-3">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("folders.changesLoading")}
          </div>
        ) : changeCount === 0 && !groups.some((g) => g.error) ? (
          <p className="p-2 text-sm text-muted-foreground">
            {t("folders.changesEmpty")}
          </p>
        ) : (
          <div ref={scrollRef} className="h-full overflow-y-auto pr-0.5">
            {groups.map((group) => {
              const showHeader =
                grouped && (group.files.length > 0 || group.error);
              return (
                <div key={group.repo.path}>
                  {showHeader && (
                    <div className="mb-2 flex items-center gap-2 border-b border-border/50 pb-1">
                      <span
                        className="min-w-0 truncate text-xs font-medium"
                        title={group.repo.relative || group.repo.name}
                      >
                        {group.repo.name}
                      </span>
                      {/* Projeto aninhado: o caminho desfaz a dúvida de qual
                          "front" é este. */}
                      {group.repo.relative.includes("/") && (
                        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                          {group.repo.relative}
                        </span>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
                        <span className="text-muted-foreground">
                          {t("folders.changesCount", {
                            count: group.files.length,
                          })}
                        </span>
                        {group.totals.added > 0 && (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{group.totals.added}
                          </span>
                        )}
                        {group.totals.removed > 0 && (
                          <span className="text-red-600 dark:text-red-400">
                            -{group.totals.removed}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {group.error && group.files.length === 0 ? (
                    <p className="p-2 text-sm text-destructive">
                      {group.error}
                    </p>
                  ) : (
                    group.files.map((file) => {
                      const key = sectionKey(group.repo.path, file.newPath);
                      return (
                        <DiffSection
                          key={key}
                          id={key}
                          file={file}
                          open={!collapsed.has(key)}
                          active={active.has(key)}
                          flash={flash === key}
                          showAll={showAll.has(key)}
                          observe={observe}
                          sectionRef={(el) => {
                            if (el) sections.current.set(key, el);
                            else sections.current.delete(key);
                          }}
                          onToggle={() => toggle(key)}
                          onShowAll={() => markShowAll(key)}
                          onOpenFile={() =>
                            onOpenFile(joinPath(group.repo.path, file.newPath))
                          }
                        />
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ArtifactContent>
    </Artifact>
  );
}
