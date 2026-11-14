import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUp, Folder, Loader2 } from "lucide-react"
import type { ListDirsResponse } from "@shared/companion"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { peersApi } from "@/src/lib/ipc"

/**
 * Picks a folder ON THE OTHER DESKTOP: the code chat that starts there works in one of its
 * own folders, and the native folder dialog of this machine would only show ours.
 */
export function RemoteFolderPicker({ peerId, peerName, initial, open, onOpenChange, onPick }: {
  peerId: string
  peerName: string
  initial?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}) {
  const { t } = useTranslation()
  const [listing, setListing] = useState<ListDirsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const go = useCallback(
    async (path?: string) => {
      setLoading(true)
      setError(null)
      try {
        setListing(await peersApi.request<ListDirsResponse>(peerId, { type: "fs:list-dirs", ...(path ? { path } : {}) }))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [peerId],
  )

  useEffect(() => {
    if (open) void go(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("peers.remote.pickFolder", { name: peerName })}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" disabled={!listing?.parent || loading} onClick={() => listing?.parent && void go(listing.parent)}>
            <ArrowUp className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={listing?.path}>
            {listing?.path ?? "…"}
          </span>
        </div>
        <div className="flex h-64 flex-col gap-0.5 overflow-y-auto rounded-md border p-1">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="p-3 text-xs text-destructive">{error}</p>
          ) : listing && listing.dirs.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">{t("peers.files.empty")}</p>
          ) : (
            listing?.dirs.map((dir) => (
              <button
                key={dir.path}
                type="button"
                onClick={() => void go(dir.path)}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{dir.name}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!listing}
            onClick={() => {
              if (listing) onPick(listing.path)
              onOpenChange(false)
            }}
          >
            {t("peers.remote.useFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
