import { ipcRenderer, contextBridge } from 'electron'
import type { IpcRendererEvent } from 'electron'

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
