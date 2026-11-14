import { RemoteFolderPicker } from "./remote-folder-picker"
import { usePeersStore } from "@/src/stores/peers-store"
import { useRemoteFolderRequest } from "@/src/stores/remote-folder-request"

/** Answers `pickFolder()` while another desktop is the environment. */
export function RemoteFolderPickerHost() {
  const pending = useRemoteFolderRequest((s) => s.pending)
  const peerId = usePeersStore((s) => s.env)
  const peerName = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env)?.name ?? "")
  const finish = (path: string | null) => {
    const current = useRemoteFolderRequest.getState().pending
    if (!current) return
    useRemoteFolderRequest.setState({ pending: null })
    current.resolve(path)
  }
  if (peerId === "local") return null
  return (
    <RemoteFolderPicker
      peerId={peerId}
      peerName={peerName}
      initial={pending?.initial}
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) finish(null)
      }}
      onPick={(path) => finish(path)}
    />
  )
}
