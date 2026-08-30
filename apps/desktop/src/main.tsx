import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './i18n'
import './index.css'
import { esteiraApi, rotinasApi } from './lib/ipc'
import { useEsteiraStore } from './stores/esteira-store'
import { useRotinasStore } from './stores/rotinas-store'
// Efeito de import: liga a sincronizacao dos modos por chat com o mobile.
import './stores/session-modes-sync'
import './stores/worker-config-sync'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Use contextBridge
if (window.ipcRenderer) {
  window.ipcRenderer.on('main-process-message', (_event, message) => {
    console.log(message)
  })

  // Assinatura GLOBAL dos eventos do main (esteira + rotinas): o renderer é
  // espelho do engine, então os eventos precisam ser aplicados ao store mesmo
  // com a view fechada — senão mudanças vindas de outra janela ou do app
  // mobile se perdem e o board abre com dados velhos para sempre.
  esteiraApi.onEvent((evento) => useEsteiraStore.getState().aplicarEvento(evento))
  rotinasApi.onEvent((evento) => useRotinasStore.getState().aplicarEvento(evento))
}
