import { create } from "zustand"

/**
 * "Pick a folder" for code that only wants a path back (`pickFolder()`): when another desktop is the
 * environment the folder must be one of ITS folders, so instead of the native dialog of this machine
 * a picker over that machine's directories opens (RemoteFolderPickerHost, mounted in the App).
 */
interface RemoteFolderRequestState {
  pending: { initial?: string; resolve: (path: string | null) => void } | null
}

export const useRemoteFolderRequest = create<RemoteFolderRequestState>(() => ({ pending: null }))

export function requestRemoteFolder(initial?: string): Promise<string | null> {
  return new Promise((resolve) => {
    // A second request while one is open closes the first one empty-handed.
    useRemoteFolderRequest.getState().pending?.resolve(null)
    useRemoteFolderRequest.setState({ pending: { initial, resolve } })
  })
}
