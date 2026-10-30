import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary } from './components/error-boundary'
import { AppCrash } from './components/app-crash'
import './i18n'
import './index.css'
import { pipelineApi, routinesApi } from './lib/ipc'
import { usePipelineStore } from './stores/pipeline-store'
import { useRoutinesStore } from './stores/routines-store'
// Import effect: wires the per-chat mode sync with the mobile.
import './stores/session-modes-sync'
import './stores/worker-config-sync'
import './stores/model-migration-sync'
import './stores/app-settings'
import './stores/preferences-sync'
// Thinking per model (toggle + variant) with the mobile.
import './stores/reasoning-sync'
// Thinking and autonomy per CHAT with the mobile.
import './stores/session-prefs-sync'
// Message queue shared with the mobile.
import './stores/message-queue-sync'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Last net: whatever escapes the inner nets shows the error and a
        button to reload, instead of leaving the window black. */}
    <ErrorBoundary label="app" fallback={(error) => <AppCrash error={error} />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// Use contextBridge
if (window.ipcRenderer) {
  window.ipcRenderer.on('main-process-message', (_event, message) => {
    console.log(message)
  })

  // GLOBAL subscription to the main process events (pipeline + routines): the
  // renderer mirrors the engine, so events must be applied to the store even
  // with the view closed — otherwise changes coming from another window or from
  // the mobile app are lost and the board opens with stale data forever.
  pipelineApi.onEvent((event) => usePipelineStore.getState().applyEvent(event))
  routinesApi.onEvent((event) => useRoutinesStore.getState().applyEvent(event))
}
