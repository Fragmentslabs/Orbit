/**
 * "Full screen" pattern of the panel tabs (Browser, Motion, Design and the
 * Design presentation).
 *
 * It is not the WINDOW's full screen: the app bar (`Titlebar`, `h-8`, with the menu and
 * the minimize/maximize/close buttons) stays where it is, and the tab only
 * grows to fill the rest of the area — its header stays BELOW the bar,
 * never in its place. Covering the bar prevented closing the app and left part
 * of the buttons unresponsive (the window's drag region swallows the click under
 * any overlay).
 *
 * Every full screen overlay uses these classes — that is what keeps the `top-8`
 * equal to the Titlebar height in a single place. If the bar height changes, it changes
 * here (and in the titlebar.tsx `h-8`).
 */

/** Titlebar height in px (`h-8`) — for whoever needs the number, not the class. */
export const TITLEBAR_HEIGHT_PX = 32

/** Classes of a tab's root element while it is in full screen. */
export const FULLSCREEN_OVERLAY_CLASS = "fixed inset-x-0 bottom-0 top-8 z-[60] h-auto w-auto rounded-none border-0"
