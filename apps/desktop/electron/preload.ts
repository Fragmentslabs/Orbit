import { ipcRenderer, contextBridge, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('platform', process.platform)

// Real path of files/folders dropped by drag & drop (File.path was removed in
// Electron 32 — this is the official way to obtain the path).
contextBridge.exposeInMainWorld('getPathForFile', (file: File) => webUtils.getPathForFile(file))

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel: string, listener: (...args: unknown[]) => void) {
    const wrapper = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapper)
    return wrapper as (...args: unknown[]) => void
  },
  off(channel: string, wrapper: (...args: unknown[]) => void) {
    ipcRenderer.removeListener(channel, wrapper as Parameters<typeof ipcRenderer.removeListener>[1])
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})
