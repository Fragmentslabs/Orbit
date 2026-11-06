import { useTranslation } from "react-i18next"
import { Check, ChevronDown, Laptop, MonitorSmartphone, Network, Plug } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { EMPTY_LIST, usePeersStore } from "@/src/stores/peers-store"

/**
 * "This computer" or one of the paired desktops. Shown only once at least one
 * desktop is paired — until then there is nothing to switch to.
 */
export function EnvironmentSelector() {
  const { t } = useTranslation()
  const peers = usePeersStore((s) => s.snapshot?.peers ?? EMPTY_LIST)
  const env = usePeersStore((s) => s.env)
  const setEnv = usePeersStore((s) => s.setEnv)
  const openConnect = usePeersStore((s) => s.openConnect)
  if (peers.length === 0) return null
  const current = env === "local" ? null : peers.find((p) => p.peerId === env)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("peers.env.label")}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-accent",
          current ? "border-primary/40 bg-primary/5" : "bg-background/40",
        )}
      >
        {current ? <Network className="size-3.5 shrink-0 text-primary" /> : <Laptop className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate font-medium">{current ? current.name : t("peers.env.local")}</span>
        {current ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", current.online ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden />
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={() => setEnv("local")} className="gap-2 text-xs">
          <Laptop className="size-3.5" />
          <span className="flex-1">{t("peers.env.local")}</span>
          {env === "local" ? <Check className="size-3.5" /> : null}
        </DropdownMenuItem>
        {peers.map((peer) => (
          <DropdownMenuItem key={peer.peerId} onClick={() => setEnv(peer.peerId)} className="gap-2 text-xs">
            <MonitorSmartphone className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{peer.name}</span>
            <span className={cn("size-1.5 rounded-full", peer.online ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden />
            {env === peer.peerId ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openConnect("computer")} className="gap-2 text-xs">
          <Plug className="size-3.5" />
          {t("peers.env.connect")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
