import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AppWindow, Maximize2, RotateCw, Sparkles, Trash2, X } from "lucide-react"
import { FRAGMENT_READ_ONLY_METHODS, FRAGMENT_SCHEME } from "@shared/fragments"
import type { FragmentManifest } from "@shared/fragments"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ArtifactToolbar, IconAction } from "@/src/components/ai/artifact-part"
import { fragmentApi } from "@/src/lib/ipc"
import { useWorkspace } from "@/lib/workspace-context"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * A fragment on screen: a sandboxed iframe that loads `orbit-fragment://<id>/`.
 *
 * Same confinement as the artifact — `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so the page lives in an opaque origin with no access to the
 * Orbit window — and, on top of it, a CSP served by the scheme that closes the network.
 *
 * The page talks to Orbit through `window.orbit`, whose calls arrive here as
 * postMessage. This component is only the courier: it forwards them to the main process,
 * which checks what the fragment declared and what the USER allowed. Three guards make
 * sure the courier serves the right sender: the message must come from THIS iframe's
 * window, must carry the token of THIS load (a page that navigated away does not know
 * it), and the fragment id is the host's — never read from the message.
 *
 * The same pieces (`useFragment`, `FragmentFrame`) serve the side-panel tab below and
 * the Fragments page (see fragments/fragment-screen.tsx).
 */

const SANDBOX = "allow-scripts"

/** What inspect mode reports about the clicked element. */
export interface InspectedElement {
  tag: string
  selector: string
  text: string
  html: string
}

/** The page is untrusted: keep only strings, clipped. `null` = the person cancelled. */
function readInspected(raw: unknown): InspectedElement | null {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  if (value.cancel === true || typeof value.tag !== "string") return null
  const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")
  return { tag: clip(value.tag, 30), selector: clip(value.selector, 400), text: clip(value.text, 300), html: clip(value.html, 1000) }
}

/** The manifest of a fragment, kept fresh while it is on screen. */
export function useFragment(fragmentId: string) {
  const [manifest, setManifest] = useState<FragmentManifest | null>(null)
  const [missing, setMissing] = useState(false)

  const refresh = useCallback(() => {
    void fragmentApi.get(fragmentId).then((found) => {
      setManifest(found)
      setMissing(!found)
    })
  }, [fragmentId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The agent rewrote a file (revision up → the frame remounts) or the person changed
  // the manifest (same revision → only the chrome around the frame changes).
  useEffect(
    () =>
      fragmentApi.onUpdated((payload) => {
        if (payload.fragmentId === fragmentId) refresh()
      }),
    [fragmentId, refresh],
  )

  return { manifest, missing }
}

/** The iframe plus the courier. `reloads` forces a remount (the reload button). */
export function FragmentFrame({
  manifest,
  sessionId,
  reloads,
  className,
  preview = false,
  readOnly = false,
  inspecting = false,
  onInspect,
}: {
  manifest: FragmentManifest
  sessionId?: string
  reloads: number
  className?: string
  /** Inspect mode: the page highlights what is under the pointer and reports the click. */
  inspecting?: boolean
  /** The element the person clicked (`null` = they pressed Escape). Only called while `inspecting`. */
  onInspect?: (element: InspectedElement | null) => void
  /**
   * A thumbnail in the gallery: the page runs, but it is a picture — it can never reach
   * Orbit (every `window.orbit` call is refused here, so a card can not spend tokens or
   * write data just by being on screen), it takes no input, and it is hidden from tab order.
   */
  preview?: boolean
  /**
   * A widget on the home screen: it may read what it saved (so it shows real data) but
   * everything else is refused — no writes, no model — because a card must never spend or
   * change anything just by being on screen.
   */
  readOnly?: boolean
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const inspectingRef = useRef(inspecting)
  const onInspectRef = useRef(onInspect)
  inspectingRef.current = inspecting
  onInspectRef.current = onInspect
  const fragmentId = manifest.id
  const loadKey = `${fragmentId}:${manifest.revision}:${reloads}`
  // New token per load: only the page THIS load produced can talk to Orbit.
  const token = useMemo(() => crypto.randomUUID(), [loadKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const src = `${FRAGMENT_SCHEME}://${fragmentId}/index.html?rev=${manifest.revision}&__t=${token}`

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as {
        __orbit?: number
        t?: string
        id?: number
        method?: string
        params?: unknown
        log?: { level?: string; message?: unknown }
        inspect?: unknown
      } | null
      if (!data || data.__orbit !== 1 || data.t !== token) return
      if (preview) {
        if (typeof data.id === "number") {
          frame.contentWindow?.postMessage({ __orbit: 1, id: data.id, ok: false, error: { code: "preview", message: "preview only" } }, "*")
        }
        return
      }

      if (data.inspect) {
        // Only while the person has inspect mode on: a page cannot push elements into the composer on its own.
        if (inspectingRef.current) onInspectRef.current?.(readInspected(data.inspect))
        return
      }
      if (data.log) {
        const level = data.log.level === "warn" || data.log.level === "error" || data.log.level === "info" ? data.log.level : "log"
        fragmentApi.log(fragmentId, { at: Date.now(), level, message: String(data.log.message ?? "") })
        return
      }
      if (typeof data.id !== "number" || typeof data.method !== "string") return
      const id = data.id
      if (readOnly && !FRAGMENT_READ_ONLY_METHODS.includes(data.method)) {
        frame.contentWindow?.postMessage({ __orbit: 1, id, ok: false, error: { code: "read_only", message: "this card is read-only" } }, "*")
        return
      }
      const reply = (payload: object) => frame.contentWindow?.postMessage({ __orbit: 1, id, ...payload }, "*")
      fragmentApi
        .call({ fragmentId, sessionId, method: data.method, params: data.params })
        .then((result) => reply(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }))
        .catch((err) =>
          reply({ ok: false, error: { code: "failed", message: err instanceof Error ? err.message : String(err) } }),
        )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [fragmentId, sessionId, token, preview, readOnly])

  // Mirrors the app theme into the page (it is an opaque origin and does not see our classes).
  const sendTheme = useCallback(() => {
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
    frameRef.current?.contentWindow?.postMessage({ type: "orbit:theme", theme }, "*")
  }, [])
  // Inspect mode is switched on in the page by a message; a freshly loaded page asks again.
  const sendInspect = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "orbit:inspect", on: inspectingRef.current }, "*")
  }, [])
  useEffect(() => {
    sendInspect()
  }, [inspecting, sendInspect])
  useEffect(() => {
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [sendTheme])

  return (
    <iframe
      key={loadKey}
      ref={frameRef}
      src={src}
      title={manifest.name}
      sandbox={SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      onLoad={() => {
        sendTheme()
        sendInspect()
      }}
      tabIndex={preview ? -1 : undefined}
      className={className ?? "w-full flex-1 border-0 bg-white"}
    />
  )
}

/**
 * The ask for the model, as a floating badge over the top of the fragment — shown while it
 * wants to use the AI and the person has not allowed it, and gone otherwise (it leaves no
 * bar or border behind). Whoever shows it gives it a `relative` area to float in.
 */
export function FragmentAiBadge({ manifest }: { manifest: FragmentManifest }) {
  const { t } = useTranslation()
  const [dismissed, dismiss] = useDismissed(`orbit-fragment-ai-badge:${manifest.id}`)
  // Closing only hides the ask: the fragment's menu still offers to allow its AI.
  if (dismissed || !manifest.requests.includes("ai") || manifest.grants.includes("ai")) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full animate-in items-center gap-2.5 rounded-full border border-primary/25 bg-background/90 py-1.5 pl-2 pr-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md duration-300 fade-in-0 slide-in-from-top-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="size-3.5" />
        </span>
        <span className="min-w-0 truncate text-xs text-foreground">{t("fragments.aiBanner")}</span>
        <Button
          size="sm"
          className="h-6 shrink-0 rounded-full px-3 text-xs"
          onClick={() => void fragmentApi.grant(manifest.id, "ai", true)}
        >
          {t("fragments.aiAllowButton")}
        </Button>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={dismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** A choice to hide something, remembered per key. Storage can be blocked: it then lasts until the view closes. */
function useDismissed(key: string): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1"
    } catch {
      return false
    }
  })
  const dismiss = useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(key, "1")
    } catch {
      /* the choice is a convenience */
    }
  }, [key])
  return [dismissed, dismiss]
}

/** Confirmation before a fragment and everything it saved is removed. */
export function DeleteFragmentDialog({
  open,
  onOpenChange,
  fragmentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fragmentId: string
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("fragments.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("fragments.deleteDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("fragments.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false)
              void fragmentApi.remove(fragmentId)
            }}
          >
            {t("fragments.confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function FragmentTab({
  fragmentId,
  title,
  sessionId,
}: {
  fragmentId?: string
  title: string
  sessionId?: string
}) {
  if (!fragmentId) return <FragmentPicker sessionId={sessionId} />
  return <FragmentPanelView key={fragmentId} fragmentId={fragmentId} title={title} sessionId={sessionId} />
}

function FragmentPanelView({
  fragmentId,
  title,
  sessionId,
}: {
  fragmentId: string
  title: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const { manifest, missing } = useFragment(fragmentId)
  const { setView } = useWorkspace()
  const [reloads, setReloads] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(
    () =>
      fragmentApi.onRemoved(({ fragmentId: gone }) => {
        if (gone === fragmentId) usePanelStore.getState().closeFragmentTabs([fragmentId])
      }),
    [fragmentId],
  )

  if (missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("fragments.unavailable")}
      </div>
    )
  }

  const asksAi = manifest?.requests.includes("ai") ?? false
  const aiOn = manifest?.grants.includes("ai") ?? false

  return (
    <div className="group/artifact flex min-w-0 flex-1 flex-col overflow-hidden bg-sidebar">
      <ArtifactToolbar
        icon={AppWindow}
        title={manifest?.name || title}
        actions={
          <>
            {asksAi && (
              <IconAction
                icon={Sparkles}
                label={t(aiOn ? "fragments.aiRevoke" : "fragments.aiAllow")}
                active={aiOn}
                onClick={() => void fragmentApi.grant(fragmentId, "ai", !aiOn)}
              />
            )}
            <IconAction icon={RotateCw} label={t("fragments.reload")} onClick={() => setReloads((n) => n + 1)} />
            <IconAction
              icon={Maximize2}
              label={t("fragments.fullscreen")}
              onClick={() => {
                // The page takes over: the fragment is not kept running twice.
                usePanelStore.getState().closeFragmentTabs([fragmentId])
                useFragmentsStore.getState().open(fragmentId)
                setView("fragments")
              }}
            />
            <IconAction icon={Trash2} label={t("fragments.delete")} onClick={() => setConfirmDelete(true)} />
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {manifest && <FragmentAiBadge manifest={manifest} />}
        {manifest && <FragmentFrame manifest={manifest} sessionId={sessionId} reloads={reloads} />}
      </div>
      <DeleteFragmentDialog open={confirmDelete} onOpenChange={setConfirmDelete} fragmentId={fragmentId} />
    </div>
  )
}

/** The "+" selector's fragment tab: the fragments that already exist. */
function FragmentPicker({ sessionId }: { sessionId?: string }) {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState<FragmentManifest[] | null>(null)

  const load = useCallback(() => {
    void fragmentApi.list().then(setItems)
  }, [])
  useEffect(() => {
    load()
    const offUpdated = fragmentApi.onUpdated(load)
    const offRemoved = fragmentApi.onRemoved(load)
    return () => {
      offUpdated()
      offRemoved()
    }
  }, [load])

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
      <h2 className="text-sm font-medium">{t("fragments.pickerTitle")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("fragments.pickerHint")}</p>

      {items && items.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t("fragments.pickerEmpty")}</p>
      )}

      <ul className="mt-3 flex flex-col gap-1.5">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => usePanelStore.getState().openFragmentTab({ id: item.id, title: item.name, sessionId })}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AppWindow className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{item.name}</span>
                {item.requests.includes("ai") && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {t("fragments.usesAi")}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {new Date(item.updatedAt).toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit" })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
