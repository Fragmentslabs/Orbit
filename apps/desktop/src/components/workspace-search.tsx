"use client";

/**
 * A busca unificada do espaço de trabalho.
 *
 * Um campo, dois grupos: os arquivos cujo NOME casa com a consulta e as
 * OCORRÊNCIAS dentro do texto deles. Os dois vêm do mesmo índice no main, mas
 * custam de formas diferentes — nomes são memória (décimos de milissegundo) e
 * ocorrências leem disco (~100 ms por passada neste repo). Por isso eles não
 * esperam um pelo outro: os nomes aparecem na primeira tecla, e as ocorrências
 * chegam depois, com debounce e cancelamento.
 *
 * O grupo colapsado NÃO busca — mas também não perde o que já achou: fechar
 * "Ocorrências" cancela a varredura e mantém a lista debaixo do cabeçalho, que
 * continua ali para reabrir. Sumir com o grupo seria destruir o resultado e a
 * única porta de volta.
 *
 * A barra é a mesma no painel e no modal (⌘P). O que muda é o alcance da
 * substituição: no painel só "substituir em todos" (a lista é o espaço
 * inteiro); no modal, que abre com um arquivo em foco, também "neste arquivo",
 * que troca no BUFFER do editor — passa pelo desfazer e pelo salvamento
 * automático em vez de escrever por baixo de um rascunho.
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
  ALargeSmallIcon,
  CaseSensitiveIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  ListFilterIcon,
  Loader2,
  RegexIcon,
  ReplaceIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  workspaceApi,
  type WsLineHit,
  type WsMatchOptions,
} from "@/src/lib/ipc";
import { previewLine } from "@/src/lib/text-match";

/** Espera depois da última tecla. */
const NAME_DEBOUNCE_MS = 90;
const TEXT_DEBOUNCE_MS = 220;
/** Abaixo disto a varredura de texto custa mais do que entrega. */
const MIN_TEXT_QUERY = 2;

interface NameRow {
  /** Caminho absoluto — é o que o visualizador abre. */
  path: string;
  /** Caminho relativo à raiz, para exibir. */
  rel: string;
  name: string;
  dir: string;
  root: string;
}

interface OccurrenceRow {
  path: string;
  rel: string;
  root: string;
  count: number;
  lines: WsLineHit[];
}

export interface WorkspaceSearchProps {
  /** As pastas do workspace — a busca cobre todas. */
  roots: string[];
  /** Arquivo aberto no visualizador, alvo do "substituir neste arquivo". */
  openFile?: string | null;
  /** Abre um resultado; `line` é 1-based quando veio de uma ocorrência. */
  onOpen: (path: string, line?: number) => void;
  /** Substitui no BUFFER do arquivo aberto (nunca no disco por baixo dele). */
  onReplaceInFile?: (
    query: string,
    replacement: string,
    options: WsMatchOptions,
  ) => number;
  /** Avisa quais arquivos mudaram em disco, para o painel recarregar. */
  onReplaced?: (written: string[]) => void;
  /**
   * A consulta daqui também grifa o arquivo aberto no visualizador. Vazio
   * limpa o grifo — o campo é a mesma busca, só que apontada no texto.
   */
  onHighlightQuery?: (query: string, options: WsMatchOptions) => void;
  variant?: "panel" | "dialog";
  autoFocus?: boolean;
  /**
   * O que aparece quando não há consulta — no painel, a árvore. Digitar troca
   * isto pelos resultados; apagar traz de volta. É o que faz a busca ser um
   * campo NO índice, e não uma tela paralela.
   */
  children?: ReactNode;
  className?: string;
}

/** Caminho absoluto a partir da raiz e do relativo que o main devolve. */
function absolutePath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

/** Trecho da linha recortado pelo começo, com o intervalo realçado. */
function CodeLine({
  text,
  start,
  length,
  tone,
}: {
  text: string;
  start: number;
  length: number;
  tone: "match" | "insert";
}) {
  const before = text.slice(0, start);
  const mid = text.slice(start, start + length);
  const after = text.slice(start + length);
  // Linha longa: mostra a cauda do que vem antes, e não o começo — o trecho
  // realçado é a única parte que precisa estar na tela.
  const lead = before.length > 30 ? `…${before.slice(-30)}` : before;

  return (
    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
      {lead}
      <span
        className={cn(
          "rounded-[3px] px-px",
          // Antes em vermelho, depois em verde — a convenção do diff, para a
          // prévia se ler sem explicação.
          tone === "match"
            ? "bg-destructive/20 text-destructive"
            : "bg-emerald-500/20 text-emerald-500",
        )}
      >
        {mid}
      </span>
      {after.slice(0, 150)}
    </span>
  );
}

/**
 * A linha como ela ficaria depois da substituição, logo abaixo da atual.
 *
 * É o que transforma "5 ocorrências em 2 arquivos" em uma decisão: o usuário
 * vê o texto antes e depois no próprio lugar, com a parte trocada realçada —
 * sem precisar aplicar para descobrir, e sem desfazer depois.
 */
function PreviewRow({
  hit,
  replacement,
  options,
}: {
  hit: WsLineHit;
  replacement: string;
  options: WsMatchOptions;
}) {
  const next = previewLine(hit.text, hit, replacement, options);
  const start = Math.max(0, hit.column - 1);
  const inserted = next.length - hit.text.length + hit.length;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="w-6 shrink-0 text-right font-mono text-[9.5px] text-emerald-500/70">
        →
      </span>
      <CodeLine text={next} start={start} length={inserted} tone="insert" />
    </span>
  );
}

/** Botão de estado pequeno — hoje só o "preservar caixa", no substituir. */
function IconToggle({
  active,
  title,
  onToggle,
  children,
}: {
  active: boolean;
  title: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
        active
          ? "bg-primary/15 text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Uma opção do popover de filtros: ícone, rótulo e o visto quando ligada.
 * O popover NÃO fecha a cada clique — os filtros combinam entre si, e fechar
 * obrigaria a reabrir para ligar o segundo.
 */
function FilterOption({
  active,
  icon,
  label,
  onToggle,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CheckIcon
        className={cn("size-3 shrink-0 text-primary", !active && "opacity-0")}
      />
    </button>
  );
}

/** Cabeçalho de grupo: o clique só fecha — a lista continua existindo. */
function GroupHead({
  open,
  label,
  count,
  onToggle,
}: {
  open: boolean;
  label: string;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-7 w-full items-center gap-1 rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 transition-transform",
          open && "rotate-90",
        )}
      />
      {label}
      <span className="ml-auto rounded-full bg-muted-foreground/15 px-1.5 text-[9.5px] tabular-nums">
        {count}
      </span>
    </button>
  );
}

export function WorkspaceSearch({
  roots,
  openFile,
  onOpen,
  onReplaceInFile,
  onReplaced,
  onHighlightQuery,
  variant = "panel",
  autoFocus = false,
  children,
  className,
}: WorkspaceSearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [preserveCase, setPreserveCase] = useState(true);

  const [names, setNames] = useState<NameRow[]>([]);
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [matches, setMatches] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [invalidPattern, setInvalidPattern] = useState(false);

  /** Grupos abertos. Fechar "Ocorrências" cancela a varredura de texto. */
  const [namesOpen, setNamesOpen] = useState(true);
  const [occurrencesOpen, setOccurrencesOpen] = useState(true);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Muda a cada substituição para a busca rodar de novo. */
  const [reload, setReload] = useState(0);

  const requestSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootsKey = roots.join("\n");
  /**
   * A lista de raízes é lida por ref dentro dos efeitos: `rootsKey` é quem diz
   * que ela mudou. Sem isso, cada render com um array novo (mesmo conteúdo)
   * reagendaria a varredura de texto e jogaria fora o resultado na tela.
   */
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  const options = useMemo<WsMatchOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);

  // Nomes: memória, sem debounce longo. O que aparece aqui é a lista do índice
  // filtrada no main — a mesma que a paleta do `@` usa.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setNames([]);
      return;
    }
    // Colapsado não busca; e o que já foi achado fica, para reabrir.
    if (!namesOpen) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void Promise.all(
        rootsRef.current.map(async (root) => {
          const result = await workspaceApi.names({ root, query: q });
          if (!result.ok) return [];
          return result.hits.map<NameRow>((hit) => ({
            root,
            rel: hit.path,
            path: absolutePath(root, hit.path),
            name: hit.name,
            dir: hit.dir,
          }));
        }),
      ).then((batches) => {
        if (alive) setNames(batches.flat());
      });
    }, NAME_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, namesOpen, rootsKey]);

  // Ocorrências: disco. Só com consulta suficiente, e só com o grupo aberto.
  // Consulta curta LIMPA (resultado de uma letra não diz nada); grupo fechado
  // apenas para de buscar e mantém a lista anterior.
  useEffect(() => {
    const q = query.trim();
    if (q === "" || q.length < MIN_TEXT_QUERY) {
      setOccurrences([]);
      setMatches(0);
      setScanned(0);
      setInvalidPattern(false);
      return;
    }
    if (!occurrencesOpen) return;

    const seq = (requestSeq.current += 1);
    const ids = rootsRef.current.map((_, index) => `ws-${seq}-${index}`);
    let alive = true;
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError(null);
      void Promise.all(
        rootsRef.current.map(async (root, index) => {
          const result = await workspaceApi.text({
            id: ids[index],
            root,
            query: q,
            ...options,
          });
          return { root, result };
        }),
      ).then((batches) => {
        if (!alive) return;
        setBusy(false);
        const rows: OccurrenceRow[] = [];
        let total = 0;
        let filesScanned = 0;
        let invalid = false;
        for (const { root, result } of batches) {
          if (!result.ok) {
            setError(result.error);
            continue;
          }
          filesScanned += result.scanned;
          invalid = invalid || result.invalidPattern === true;
          for (const file of result.occurrences) {
            total += file.count;
            rows.push({
              root,
              rel: file.path,
              path: absolutePath(root, file.path),
              count: file.count,
              lines: file.lines,
            });
          }
        }
        rows.sort((a, b) => b.count - a.count);
        setOccurrences(rows);
        setMatches(total);
        setScanned(filesScanned);
        setInvalidPattern(invalid);
      });
    }, TEXT_DEBOUNCE_MS);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      // Cada tecla nova aborta a varredura anterior: trabalho que ninguém vai
      // ver não pode seguir lendo disco.
      for (const id of ids) void workspaceApi.cancel(id);
    };
  }, [query, options, occurrencesOpen, rootsKey, reload]);

  // O grifo no arquivo aberto segue a consulta, sem debounce: é decoração de
  // texto, não leitura de disco.
  useEffect(() => {
    onHighlightQuery?.(query.trim(), options);
  }, [query, options, onHighlightQuery]);

  const trimmed = query.trim();
  const canReplaceInFile = openFile != null && onReplaceInFile != null && trimmed !== "";
  const canReplaceAll = occurrences.length > 0 && trimmed !== "";
  const showPreview = replaceOpen && replacement !== "" && trimmed !== "";

  const replaceInFile = useCallback(() => {
    if (!canReplaceInFile || !onReplaceInFile) return;
    setStatus(null);
    const count = onReplaceInFile(trimmed, replacement, {
      ...options,
      preserveCase,
    });
    setStatus(
      count > 0
        ? t("workspaceSearch.replaced", { count, files: 1 })
        : t("workspaceSearch.noReplacements"),
    );
    setReload((value) => value + 1);
  }, [canReplaceInFile, onReplaceInFile, trimmed, replacement, options, preserveCase, t]);

  const replaceAll = useCallback(() => {
    if (!canReplaceAll) return;
    setStatus(null);
    setError(null);
    setBusy(true);

    const byRoot = new Map<string, string[]>();
    for (const occurrence of occurrences) {
      const list = byRoot.get(occurrence.root) ?? [];
      list.push(occurrence.rel);
      byRoot.set(occurrence.root, list);
    }

    void Promise.all(
      [...byRoot.entries()].map(async ([root, targets]) => {
        const result = await workspaceApi.replace({
          root,
          targets,
          query: trimmed,
          replacement,
          ...options,
          preserveCase,
        });
        return result;
      }),
    ).then((results) => {
      setBusy(false);
      let files = 0;
      let count = 0;
      const written: string[] = [];
      for (const result of results) {
        if (!result.ok) {
          setError(result.error);
          continue;
        }
        files += result.files;
        count += result.replacements;
        written.push(...result.written);
        if (result.errors.length > 0) {
          setError(
            t("workspaceSearch.replaceErrors", { count: result.errors.length }),
          );
        }
      }
      setStatus(
        count > 0
          ? t("workspaceSearch.replaced", { count, files })
          : t("workspaceSearch.noReplacements"),
      );
      if (written.length > 0) onReplaced?.(written);
      setReload((value) => value + 1);
    });
  }, [
    canReplaceAll,
    occurrences,
    trimmed,
    replacement,
    options,
    preserveCase,
    onReplaced,
    t,
  ]);

  const clear = useCallback(() => {
    setQuery("");
    setStatus(null);
    setError(null);
    searchRef.current?.focus();
  }, []);

  const rootLabel = useMemo(() => {
    if (roots.length < 2) return null;
    const labels = new Map<string, string>();
    for (const root of roots) {
      const parts = root.split(/[\\/]/).filter(Boolean);
      labels.set(root, parts[parts.length - 1] ?? root);
    }
    return labels;
  }, [roots]);

  const showNames = !replaceOpen;
  /** Quantos filtros estão ligados — o botão do popover se acende com algum. */
  const activeFilters =
    Number(caseSensitive) + Number(wholeWord) + Number(regex);
  const nothingFound =
    trimmed !== "" && !busy && names.length === 0 && matches === 0;
  // No painel o campo é só contorno: a sidebar já é a superfície, e um fundo
  // mais escuro aqui abriria uma segunda caixa dentro da mesma coluna. No
  // modal a superfície é o popover — ali o campo precisa se anunciar como
  // campo, senão vira texto solto no topo.
  const fieldClass = variant === "panel" ? "bg-transparent" : "bg-background";
  // O modal não tem a moldura do painel: o respiro vem daqui, senão o campo
  // encosta na borda do popover.
  const pad = variant === "panel" ? "px-2" : "";

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        variant === "dialog" && "p-4",
        className,
      )}
    >
      {/* Barra: consulta, os três filtros e o abre-substituir. */}
      <div className={cn("shrink-0", pad, "pb-2")}>
        <div
          className={cn(
            "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border px-2 transition-colors focus-within:border-primary/60",
            fieldClass,
          )}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (query !== "") clear();
                else searchRef.current?.blur();
              }
              if (event.key === "Enter" && names.length > 0) {
                onOpen(names[0].path);
              }
            }}
            placeholder={t("workspaceSearch.placeholder")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {busy && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
          {query !== "" && (
            <button
              type="button"
              onClick={clear}
              title={t("workspaceSearch.clear")}
              aria-label={t("workspaceSearch.clear")}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          )}
          {/* Os três filtros num popover: a barra é estreita, e três botões
              permanentes roubavam largura do próprio texto pesquisado. */}
          <Popover>
            <PopoverTrigger
              title={t("workspaceSearch.filters")}
              aria-label={t("workspaceSearch.filters")}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                activeFilters > 0
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <ListFilterIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <FilterOption
                active={caseSensitive}
                icon={<CaseSensitiveIcon className="size-3.5" />}
                label={t("workspaceSearch.caseSensitive")}
                onToggle={() => setCaseSensitive((value) => !value)}
              />
              <FilterOption
                active={wholeWord}
                icon={<WholeWordIcon className="size-3.5" />}
                label={t("workspaceSearch.wholeWord")}
                onToggle={() => setWholeWord((value) => !value)}
              />
              <FilterOption
                active={regex}
                icon={<RegexIcon className="size-3.5" />}
                label={t("workspaceSearch.regex")}
                onToggle={() => setRegex((value) => !value)}
              />
            </PopoverContent>
          </Popover>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <button
            type="button"
            onClick={() => setReplaceOpen((value) => !value)}
            title={t("workspaceSearch.replaceToggle")}
            aria-label={t("workspaceSearch.replaceToggle")}
            aria-expanded={replaceOpen}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
              replaceOpen
                ? "text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", replaceOpen && "rotate-90")}
            />
          </button>
        </div>
      </div>

      {/* Substituir: o campo novo e o botão que o alcance permite. */}
      {replaceOpen && (
        <div className={cn("shrink-0", pad, "pb-2")}>
          <div className="flex flex-col gap-1.5">
            <div
              className={cn(
                "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border px-2 transition-colors focus-within:border-primary/60",
                fieldClass,
              )}
            >
              <ReplaceIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder={t("workspaceSearch.replaceWith")}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
              <IconToggle
                active={preserveCase}
                title={t("workspaceSearch.preserveCase")}
                onToggle={() => setPreserveCase((value) => !value)}
              >
                <ALargeSmallIcon className="size-3.5" />
              </IconToggle>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {/* No painel a lista é o espaço inteiro — substituir "aqui" não
                  tem aqui. O arquivo em foco só existe no modal (⌘P). */}
              {variant === "dialog" && (
                <button
                  type="button"
                  onClick={replaceInFile}
                  disabled={!canReplaceInFile}
                  title={
                    canReplaceInFile
                      ? t("workspaceSearch.replaceInFileHint")
                      : t("workspaceSearch.replaceInFileDisabled")
                  }
                  className="h-7 w-full rounded-md border border-border px-2 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("workspaceSearch.replaceInFile")}
                </button>
              )}
              <button
                type="button"
                onClick={replaceAll}
                disabled={!canReplaceAll || busy}
                className="h-7 w-full rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("workspaceSearch.replaceAll")}
              </button>
              {matches > 0 && (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {t("workspaceSearch.occurrenceCount", {
                    count: matches,
                    files: occurrences.length,
                  })}
                </span>
              )}
            </div>
            {status && (
              <p className="text-[10px] leading-snug text-muted-foreground">{status}</p>
            )}
            {error && (
              <p className="break-words text-[10px] leading-snug text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {invalidPattern && (
        <p className={cn("shrink-0 pb-1 text-[10px] text-destructive", pad)}>
          {t("workspaceSearch.invalidPattern")}
        </p>
      )}

      {children != null && trimmed === "" ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn("flex flex-col pb-2", pad, "pr-1")}>
            {nothingFound && (
              <p className="px-2 py-3 text-[11px] leading-snug text-muted-foreground">
                {t("workspaceSearch.empty")}
              </p>
            )}

            {/* Arquivos — o grupo sai do caminho quando se está substituindo:
                o assunto lá é onde o texto aparece, não nomes de arquivo. */}
            {showNames && trimmed !== "" && (
              <section className="flex flex-col">
                <GroupHead
                  open={namesOpen}
                  label={t("workspaceSearch.fileGroup")}
                  count={names.length}
                  onToggle={() => setNamesOpen((value) => !value)}
                />
                {namesOpen &&
                  names.map((row) => (
                    <button
                      key={row.path}
                      type="button"
                      onClick={() => onOpen(row.path)}
                      className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] hover:bg-accent"
                    >
                      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 shrink truncate">{row.name}</span>
                      <span className="ml-auto min-w-0 truncate text-[10px] text-muted-foreground">
                        {rootLabel && (
                          <span className="mr-1 text-foreground/50">
                            {rootLabel.get(row.root)}
                          </span>
                        )}
                        {row.dir}
                      </span>
                    </button>
                  ))}
              </section>
            )}

            {/* Ocorrências */}
            <section className="mt-1 flex flex-col">
              <GroupHead
                open={occurrencesOpen}
                label={t("workspaceSearch.occurrenceGroup")}
                count={matches}
                onToggle={() => setOccurrencesOpen((value) => !value)}
              />
              {occurrencesOpen &&
                occurrences.map((file) => {
                  const cut = file.rel.lastIndexOf("/");
                  const name = cut === -1 ? file.rel : file.rel.slice(cut + 1);
                  return (
                    <div key={file.path} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => onOpen(file.path)}
                        className="flex min-w-0 items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] font-medium hover:bg-accent"
                      >
                        <FileIcon className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 shrink truncate">{name}</span>
                        <span className="ml-auto shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
                          {file.count}
                        </span>
                      </button>
                      {file.lines.map((line) => (
                        <button
                          key={`${file.path}:${line.line}:${line.column}`}
                          type="button"
                          onClick={() => onOpen(file.path, line.line)}
                          className="flex min-w-0 flex-col rounded px-2 py-0.5 pl-6 text-left hover:bg-accent"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="w-6 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground/70">
                              {line.line}
                            </span>
                            <CodeLine
                              text={line.text}
                              start={Math.max(0, line.column - 1)}
                              length={line.length}
                              tone="match"
                            />
                          </span>
                          {showPreview && (
                            <PreviewRow
                              hit={line}
                              replacement={replacement}
                              options={{ ...options, preserveCase }}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
            </section>

            {trimmed !== "" && scanned > 0 && occurrences.length > 0 && (
              <p className="px-2 pt-2 text-[10px] text-muted-foreground/70">
                {t("workspaceSearch.scanned", { count: scanned })}
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
