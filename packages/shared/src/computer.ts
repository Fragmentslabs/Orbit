/**
 * Computer Use: what the main tells the renderer about computer control
 * (chip in the header, Preferences panel).
 */

/** Platforms with a Computer Use driver (macOS and Windows; see docs/computer-use-windows.md). */
export function isComputerPlatform(platform: string): boolean {
  return platform === "darwin" || platform === "win32"
}

/** The global shortcut that stops the control on the spot, as it appears in the bar and in the Preferences. */
export function computerStopShortcut(platform: string): string {
  return platform === "win32" ? "Ctrl+Shift+." : "⌘⇧."
}

/** A chat session that is controlling (or has just controlled) an app. */
export interface ComputerActivity {
  sessionId: string
  /** Name of the app targeted by the last action */
  app: string
  /** Start of the continuous control (ms) */
  startedAt: number
  /** Last action/observation (ms) */
  lastAt: number
  /** Last action, readable ("click on Save") */
  lastAction: string | null
}

export type ComputerEvent =
  | { type: "active"; activity: ComputerActivity }
  | { type: "idle"; sessionId: string }
  /** New screenshot (or marker) of the conversation — the thumbnail fetches by computer:shot */
  | { type: "shot"; sessionId: string; at: number }

/** Last screenshot of the conversation, with the marker of the last action (image space). */
export interface ComputerShot {
  dataUrl: string
  width: number
  height: number
  app: string
  at: number
  marker: { x: number; y: number; w: number; h: number; label: string } | null
}

/** State of the capability on this machine (Preferences → Computer). */
export interface ComputerStatus {
  /** The platform has a driver and the build is not from the Mac App Store */
  available: boolean
  /** Reason when unavailable: "mas", "platform" */
  reason: "mas" | "platform" | null
  platform: string
  /** Accessibility granted to Orbit (Windows: the UI Automation host comes up) */
  accessibility: boolean
  /** Screen Recording: "granted" | "denied" | "not-determined" | "restricted" | "unknown" */
  screen: string
  /** In dev the permission belongs to the Electron binary, not to Orbit */
  dev: boolean
  /**
   * App that macOS considers the owner of the permissions, when it is not Orbit
   * itself: in dev, whoever ran `npm run dev` (Terminal, iTerm, VS Code…). null =
   * the app itself.
   */
  responsible: string | null
  /** What else limits the control on this machine (Windows: restricted PowerShell, integrity) */
  notes?: string[]
}

/** Result of the "Test" button (a real call to the bridge). */
export interface ComputerTestResult {
  ok: boolean
  /** Time of the app list + tree of the front app */
  ms: number
  message: string
}
