import { randomUUID } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import { FRAGMENT_MAX_HOSTS } from '@shared/fragments'
import { listMcpServerNames, listMcpServerToolNames } from '../mcp'
import {
  clearFragmentLogs,
  createFragment,
  deleteFragmentFile,
  editFragmentFile,
  getFragment,
  listFragmentFiles,
  listFragments,
  readFragmentData,
  readFragmentFile,
  readFragmentLogs,
  setFragmentHosts,
  setFragmentMcp,
  setFragmentWidgets,
  setRequested,
  writeFragmentFile,
} from '../fragments/fragment-store'
import { withRevision } from '../fragments/fragment-history'
import { panelFragmentOpen } from '../panel-browser'
import { applyTextEditsDetailed } from './piece-common'

/**
 * Fragments: a live screen in the side panel that the agent builds and edits, and that
 * can talk to Orbit through `window.orbit`.
 *
 * Every write reloads the tab, so the person watches the screen change while the
 * conversation goes on. The agent writes code ONLY — it cannot allow anything for the
 * fragment: capabilities such as `orbit.ai` are granted by the user, in the tab.
 */

const SDK_REFERENCE = `
window.orbit is already loaded in every fragment page (do not add a script for it):
- orbit.store.get(key) / set(key, value) / delete(key) / keys() — persistent JSON storage for this fragment (survives reloads; values are JSON, up to 256KB each). Use it for anything the user would expect to still be there tomorrow.
- orbit.ai.generate({ prompt, system? }) → Promise<{ text }> — asks the user's own model. Only works when the fragment was created with usesAi: true AND the user turned it on in the tab (until then it rejects with err.code === "permission_denied": catch it and show a clear message in the UI). Limited to a few calls per minute: never call it in a loop or on every keystroke.
- orbit.models.list() → Promise<[{ providerId, providerName, modelId, name, reasoning }]>, orbit.models.get() → Promise<{ providerId, modelId } | null>, orbit.models.set({ providerId, modelId }) (or set(null) to follow the chat) — lets YOUR screen offer the choice of the model that orbit.ai uses. Only after you call fragment_set_models AND the user allows it; then the app header no longer shows a model control, so build one.
- orbit.theme ("light" | "dark") and orbit.on("theme", fn) — the app theme. The Orbit CSS variables are already defined and follow it: --background, --foreground, --card, --card-foreground, --primary, --primary-foreground, --secondary, --muted, --muted-foreground, --accent, --border, --input, --ring, --radius and --font-sans. Style with them (e.g. body { background: var(--background) }) so the screen looks native in light and dark.
- orbit.http.fetch(url, { method?, headers?, body? }) → Promise<{ status, ok, url, headers, text, truncated, json() }> — the ONLY way to reach the internet. https only, and only hosts you declared with fragment_set_http AND the user allowed (until then: err.code "permission_denied"; an undeclared host: "host_not_allowed"). The app does the request: no cookies, no Authorization/Cookie headers, response capped at 2MB, 20s, 30 calls/minute. body is a string (JSON.stringify it).
- orbit.mcp.list() → [{ server, connected, tools: [{ name, available }] }] and orbit.mcp.call(server, tool, args) → Promise<{ text, truncated }> — uses tools of MCP servers the user already connected. Only server/tool pairs you declared with fragment_set_mcp AND the user allowed. Errors: "mcp_unavailable" (server not connected), "tool_not_allowed", "mcp_tool_error" (the tool failed; err.message has its text). 20 calls/minute; result is text, capped.
- orbit.notify.show({ title, body? }) — a toast in the app now. orbit.notify.schedule({ id, title, body?, at | dailyAt | everyMinutes }) — a notification the APP keeps and fires even with this page closed (only while Orbit is open); "at" is epoch ms, "dailyAt" is "HH:MM" local, "everyMinutes" is at least 1 (the fragment may keep 20 schedules at once, and 6 notifications a minute are delivered). The id is the identity: schedule again with the same id to update it instead of stacking. orbit.notify.list() and orbit.notify.cancel(id?) (no id cancels all). Works only when you call fragment_set_notify AND the user allows it. Typical use: on load, read the data, compute what is due and schedule one "at" per item with a stable id (e.g. "task-<id>"), so re-opening the screen never duplicates.
- orbit.permissions.state(capability) → "granted" | "denied" | "not_requested" and orbit.permissions.request(capability) — let YOUR screen show "notifications are blocked" with a button, and re-open the app's ask when the user clicks it (the page can only ask, never allow).
- Microphone: navigator.mediaDevices.getUserMedia({ audio: true }) (plus MediaRecorder) works once the person allows it — the first call is refused and puts the app's notice up over the fragment (the same notice the other permissions use); after the person clicks Allow there, the call works. Nothing else is needed: catch NotAllowedError, show a clear message and offer a "try again" button, and orbit.permissions.state("microphone") tells you whether to point at "allow it in the notice above". Camera is NOT available.
Errors from orbit calls carry err.code.

WIDGETS — small versions of this screen for the board beside the chat. Declare them in fragment_create (or afterwards with fragment_set_widgets): an id, a name and the sizes it knows how to draw. The board is 2 columns of 72px cells with an 8px gap, so each box is EXACTLY: 1x1 = 72x72, 2x1 = 152x72, 1x2 = 72x152, 2x2 = 152x152.
When the person places one, THIS SAME PAGE is loaded in that box with ?widget=<id>&size=<size>. Read both ONCE, in <head>, before anything renders, and put them on the root element:
<script>const q=new URLSearchParams(location.search);const w=q.get("widget");if(w){document.documentElement.dataset.widget=w;document.documentElement.dataset.size=q.get("size")||"2x2"}</script>
Then the widget is a MODE of the page, never a separate document: CSS hides the screen and shows one block — html[data-widget] .screen{display:none} and html[data-widget="total"] .w-total{display:flex}.
These rules decide whether the widget looks right or broken:
- The box IS the canvas: margin:0 and padding:0 on body, width:100% and height:100%, overflow:hidden on html, body and the widget block. No fixed pixel width, no margin auto, nothing wider than 100% or taller than 100%. A widget that scrolls is broken.
- Text sized for the box, not for the screen. Safe ranges: 1x1 → one value at 18-20px (weight 600, font-variant-numeric: tabular-nums) and ONE label at 9px uppercase with at most two words — no title, no second row, nothing else. 2x1 → a value at 18-20px with a 9-10px label, one row. 1x2 → value on top, two or three 9-10px rows below. 2x2 → value plus one small chart or three rows, at 10-11px.
- Everything must fit: one-line text gets white-space:nowrap; overflow:hidden; text-overflow:ellipsis, two lines get -webkit-line-clamp:2, and every flex child that holds text gets min-width:0. Shorten the label before the number is ever clipped.
- Declare a size only where the widget really reads well. A 1x1 carrying a title, a subtitle and a legend is broken by construction: if the content needs two rows, declare 1x2, not 1x1. Declaring fewer sizes is better than declaring one that looks wrong.
- Adapt across sizes from the size the page received (html[data-size="1x1"] ...), with flex/grid, percentages and clamp() — never fixed widths. @container queries are fine when the shape has to change.
- No header, no page title, no tabs, no buttons, no legend inside a widget: it is a glance. A click opens the destination, which the app handles.
- Without ?widget the page keeps working as the full screen, with the widget blocks hidden.

LOOK — every screen and every widget follows this, no exceptions:
- Colors come ONLY from the variables above; they are already defined in the page and change with the app theme. NEVER write a fixed color for text or background (color: #000, black, #111, white, #fff): in the dark theme the text disappears. Page: var(--background); surface: var(--card); soft fill: var(--muted); text: var(--foreground); secondary text: var(--muted-foreground); hairline: var(--border); the single accent: var(--primary), with var(--primary-foreground) on top of it.
- Text: font-family: var(--font-sans). Calm and small — 10-11px UPPERCASE labels with letter-spacing .08em, 13-15px body, and ONE big number per screen (24-32px, weight 600, letter-spacing -0.02em, font-variant-numeric: tabular-nums). Never text under 9px.
- Icons: inline SVG drawn in the lucide style — viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round", 16-18px, colored by currentColor. NEVER emoji: they look like a toy, render differently on every machine and clash with the rest of the app. No icon font and no CDN — the sandbox has none.
- Surfaces: var(--card) with 1px solid var(--border) and border-radius var(--radius) (10px for something inside a card). Flat: no heavy shadows, no gradients.
- Spacing on a 4px grid (4/8/12/16/24), generous. One idea per screen: a title, the thing, and air.
- A widget inherits all of this at miniature scale: 1x1 is one number plus one word (10-18px); 2x2 may add a tiny inline SVG sparkline. No header, no buttons, no legend.

Hard limits of the page (a closed sandbox): NO direct network — no fetch to the internet from the page (use orbit.http), no CDN scripts, no external images, fonts or iframes. Write plain HTML/CSS/JavaScript (ES modules between your own files are fine); draw charts with inline SVG or <canvas>. Files: index.html is the entry; add style.css, app.js, etc. with fragment_write_file and reference them relatively (<link href="style.css">, <script src="app.js">). Allowed file types: html, css, js, mjs, json, svg, txt, csv, md.
After writing, the panel reloads by itself. Call fragment_logs to read the page's console and errors and fix what is broken.`

const CREATE_DESCRIPTION = `Creates a FRAGMENT: a small interactive screen that opens in the side panel next to the chat and that the user can keep using — a tool, tracker, dashboard, mini-app or utility, not a one-off illustration of an answer (for that, create_artifact). It is saved, shows up again later, and can store data and ask Orbit's model through window.orbit. Send a complete index.html (inline CSS/JS is fine, or split into files afterwards). From then on, keep refining it with fragment_edit_file / fragment_write_file as the user asks: the panel reloads on every write, so they watch it change live.
${SDK_REFERENCE}`

const MAX_READ_DATA_CHARS = 30_000

class FileMissing extends Error {}

const FragmentIdSchema = z.string().describe('The fragmentId returned by fragment_create (frag-…)')

/** The tool result for a failed action: the model reads it and decides what to do. */
function failed(action: string, err: unknown): string {
  return `Could not ${action}: ${err instanceof Error ? err.message : String(err)}`
}

function notFound(id: string): string {
  return `Fragment not found: ${id}. List the existing ones with fragment_list or create a new one with fragment_create.`
}

export function createFragmentTools(sessionId: string) {
  // The tools are built once per agent turn, so every write below shares this id: it is what
  // the history groups by and what the person reverts ("undo this turn").
  const turnContext = { turn: randomUUID(), sessionId }

  /** Opens/focuses the tab and builds the part of the result that is the same everywhere. */
  async function opened(id: string, revision: number, lead: string): Promise<string> {
    const manifest = await getFragment(id)
    if (manifest) panelFragmentOpen({ id, title: manifest.name, sessionId })
    const aiNote =
      manifest && manifest.requests.includes('ai') && !manifest.grants.includes('ai')
        ? ' This fragment uses orbit.ai: it works only after the user turns on "AI" in the tab toolbar — tell them so.'
        : ''
    const waiting = manifest ? manifest.requests.filter((c) => (c === 'http' || c === 'mcp') && !manifest.grants.includes(c)) : []
    const accessNote = waiting.length ? ` Still waiting for the user to allow: ${waiting.join(', ')} (the tab shows an Allow button) — tell them so.` : ''
    return `${lead} (revision ${revision}). The person is looking at it live (on the Fragments page, or in a Fragment tab of the side panel) and it reloads on every write.${aiNote}${accessNote} Call fragment_logs to check the page for runtime errors.`
  }

  return {
    fragment_create: tool({
      description: CREATE_DESCRIPTION,
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('Short name shown in the tab and in the list'),
        html: z.string().min(1).describe('Complete index.html of the fragment'),
        icon: z
          .string()
          .optional()
          .describe(
            'A lucide icon that represents the fragment, in kebab-case ("wallet", "chart-bar", "timer", "notebook-pen", "dumbbell"). Always pick one that fits; it shows in the sidebar, the header and the gallery.',
          ),
        kind: z
          .enum(['screen', 'panel'])
          .optional()
          .describe(
            'Where it is meant to live. "screen" (default): a full page of the app. "panel": a compact tab of the side panel, designed for a narrow column. Use the kind the user asked for; it changes how much room the layout has.',
          ),
        usesAi: z
          .boolean()
          .optional()
          .describe('true when the page calls orbit.ai.generate — the user will be asked to allow it'),
        usesNotify: z
          .boolean()
          .optional()
          .describe('true when the page calls orbit.notify (reminders/toasts) — the user will be asked to allow it'),
        usesMicrophone: z
          .boolean()
          .optional()
          .describe(
            'true when the page records audio with getUserMedia (voice notes, cloning, dictation) — the user will be asked to allow the microphone',
          ),
        widgets: z
          .array(
            z.object({
              id: z.string().describe('URL-safe id: lowercase letters, digits and hyphens ("hoje", "total-do-mes")'),
              name: z.string().describe('Short name shown while choosing the widget'),
              sizes: z
                .array(z.enum(['1x1', '2x1', '1x2', '2x2']))
                .min(1)
                .describe('Every size this widget knows how to draw (a 1x1 is a single 72px cell)'),
              destination: z
                .string()
                .optional()
                .describe('Screen of this fragment a click on the widget opens (the page reads it from the URL)'),
              description: z.string().optional().describe('One line shown while choosing the widget'),
            }),
          )
          .max(8)
          .optional()
          .describe(
            'Small versions of this screen for the board beside the chat. Only when the person asked for widgets: the same page renders each one when loaded with ?widget=<id>&size=<size>.',
          ),
      }),
      execute: async ({ name, html, icon, kind, usesAi, usesNotify, usesMicrophone, widgets }) => {
        try {
          const requests = [
            ...(usesAi ? (['ai'] as const) : []),
            ...(usesNotify ? (['notify'] as const) : []),
            ...(usesMicrophone ? (['microphone'] as const) : []),
          ]
          const manifest = await createFragment({ name, html, icon, kind, requests: [...requests], widgets, sessionId })
          return {
            fragmentId: manifest.id,
            message: await opened(manifest.id, manifest.revision, `Fragment "${manifest.name}" created`),
          }
        } catch (err) {
          return failed('create the fragment', err)
        }
      },
    }),

    fragment_write_file: tool({
      description:
        'Writes (creates or replaces) ONE file of a fragment with its FULL new content, and reloads the panel. Paths are relative to the fragment (index.html, style.css, js/app.js). Prefer fragment_edit_file for small changes.',
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        path: z.string().min(1).describe('Relative path, e.g. "index.html" or "js/app.js"'),
        content: z.string().describe('The complete new content of the file'),
      }),
      execute: async ({ fragmentId, path: rel, content }) => {
        if (!(await getFragment(fragmentId))) return notFound(fragmentId)
        try {
          const manifest = await withRevision(fragmentId, turnContext, { path: rel }, () => writeFragmentFile(fragmentId, rel, content))
          return await opened(fragmentId, manifest.revision, `Wrote ${rel}`)
        } catch (err) {
          return failed(`write ${rel}`, err)
        }
      },
    }),

    fragment_edit_file: tool({
      description:
        'Edits ONE file of a fragment with EXACT text replacements, applied in order (oldText must exist and be unique unless replaceAll), and reloads the panel. Prefer this over fragment_write_file for small changes: it does not resend the whole file. If oldText does not match, fragment_read_file and retry.',
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        path: z.string().min(1).describe('Relative path, e.g. "index.html"'),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe('Exact current text (copy it, including indentation)'),
              newText: z.string(),
              replaceAll: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      execute: async ({ fragmentId, path: rel, edits }) => {
        if (!(await getFragment(fragmentId))) return notFound(fragmentId)
        try {
          let appliedCount = 0
          const manifest = await withRevision(fragmentId, turnContext, { path: rel }, () =>
            editFragmentFile(fragmentId, rel, (current) => {
              if (current === null) throw new FileMissing(rel)
              const { text, applied } = applyTextEditsDetailed(current, edits)
              appliedCount = applied.length
              return text
            }),
          )
          return await opened(fragmentId, manifest.revision, `Edited ${rel} (${appliedCount} edit${appliedCount === 1 ? '' : 's'})`)
        } catch (err) {
          if (err instanceof FileMissing) return `File not found in the fragment: ${rel}. See fragment_read_file for the file list.`
          return failed(`edit ${rel}`, err)
        }
      },
    }),

    fragment_read_file: tool({
      description:
        'Reads a file of a fragment. Without `path` it returns the fragment overview instead: name, files, and what it asked for / what the user allowed.',
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        path: z.string().optional().describe('Relative path; omit for the overview'),
      }),
      execute: async ({ fragmentId, path: rel }) => {
        const manifest = await getFragment(fragmentId)
        if (!manifest) return notFound(fragmentId)
        if (!rel) {
          return {
            fragmentId,
            name: manifest.name,
            revision: manifest.revision,
            files: await listFragmentFiles(fragmentId),
            asked: manifest.requests,
            allowedByUser: manifest.grants,
          }
        }
        const content = await readFragmentFile(fragmentId, rel)
        return content ?? `File not found in the fragment: ${rel}`
      },
    }),

    fragment_delete_file: tool({
      description: 'Removes ONE file of a fragment (index.html cannot be removed) and reloads the panel.',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, path: z.string().min(1) }),
      execute: async ({ fragmentId, path: rel }) => {
        if (!(await getFragment(fragmentId))) return notFound(fragmentId)
        try {
          const manifest = await withRevision(fragmentId, turnContext, { path: rel, deleting: true }, () => deleteFragmentFile(fragmentId, rel))
          return await opened(fragmentId, manifest.revision, `Removed ${rel}`)
        } catch (err) {
          return failed(`remove ${rel}`, err)
        }
      },
    }),

    fragment_logs: tool({
      description:
        "Reads the console output and runtime errors of the fragment's page since it was last loaded (console.log/warn/error, uncaught exceptions). Call it after writing to confirm the page works, and whenever the user says something is broken. Empty output means no errors so far (or the panel tab is not open).",
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        clear: z.boolean().optional().describe('Clear the log after reading'),
      }),
      execute: async ({ fragmentId, clear }) => {
        if (!(await getFragment(fragmentId))) return notFound(fragmentId)
        const entries = readFragmentLogs(fragmentId)
        if (clear) clearFragmentLogs(fragmentId)
        if (entries.length === 0) return 'No console output or errors so far.'
        return entries.map((e) => `[${e.level}] ${e.message}`).join('\n')
      },
    }),

    fragment_set_ai: tool({
      description:
        'Declares whether the fragment uses orbit.ai. This only ASKS: the user still has to turn "AI" on in the tab toolbar, you cannot allow it.',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, usesAi: z.boolean() }),
      execute: async ({ fragmentId, usesAi }) => {
        const manifest = await setRequested(fragmentId, 'ai', usesAi)
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return usesAi
          ? 'Declared. The user must turn on "AI" in the tab toolbar before orbit.ai.generate works.'
          : 'orbit.ai is no longer requested by this fragment.'
      },
    }),

    fragment_set_models: tool({
      description:
        'Declares whether the fragment offers its OWN model picker through orbit.models (list/get/set). This only ASKS: the user still has to allow it. When allowed, the app header stops showing the model control for this fragment, so the fragment must provide one. Use it only when the user wants the choice inside the screen.',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, usesModels: z.boolean() }),
      execute: async ({ fragmentId, usesModels }) => {
        const manifest = await setRequested(fragmentId, 'models', usesModels)
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return usesModels
          ? 'Declared. The user must allow "models" for this fragment before orbit.models works; build the picker so it handles err.code === "permission_denied".'
          : 'orbit.models is no longer requested by this fragment; the header model control is back.'
      },
    }),

    fragment_set_notify: tool({
      description:
        'Declares whether the fragment sends notifications through orbit.notify (show/schedule). This only ASKS: the user still has to allow "notify" in the tab, you cannot allow it. Notifications arrive with the app open — a reminder that must survive Orbit being closed is a routine, not this.',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, usesNotify: z.boolean() }),
      execute: async ({ fragmentId, usesNotify }) => {
        const manifest = await setRequested(fragmentId, 'notify', usesNotify)
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return usesNotify
          ? 'Declared. The user must allow "notify" for this fragment before orbit.notify works; handle err.code === "permission_denied" (and orbit.permissions.request) in the UI.'
          : 'orbit.notify is no longer requested by this fragment; its scheduled notifications are discarded.'
      },
    }),

    fragment_set_microphone: tool({
      description:
        'Declares whether the fragment records audio with navigator.mediaDevices.getUserMedia. This only ASKS: the notice above the fragment appears the first time the page really records (or right away), and the user allows it there — and can turn it off in the fragment details. Declare it when the page has a record button (voice notes, voice cloning, dictation).',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, usesMicrophone: z.boolean() }),
      execute: async ({ fragmentId, usesMicrophone }) => {
        const manifest = await setRequested(fragmentId, 'microphone', usesMicrophone)
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return usesMicrophone
          ? 'Declared. The notice is up above the fragment; after the person allows it there, the page can record (macOS asks once for the whole app at that moment). Handle NotAllowedError and read orbit.permissions.state("microphone") to explain it in the screen.'
          : 'The microphone is no longer requested by this fragment; recording stops working on the next load.'
      },
    }),

    fragment_set_widgets: tool({
      description:
        'Replaces the widgets this fragment offers to the board beside the chat. Each one is the SAME page rendered with ?widget=<id>&size=<size> in a fixed box: 1x1 = 72x72, 2x1 = 152x72, 1x2 = 72x152, 2x2 = 152x152. Declare only the sizes the page really reads well at — a 1x1 holds one value and one short label and nothing else; if the content needs two rows, declare 1x2. Pass an empty list to offer none. It never changes what the person already placed on the board.',
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        widgets: z
          .array(
            z.object({
              id: z.string().describe('URL-safe id, the same the page reads from the URL'),
              name: z.string(),
              sizes: z.array(z.enum(['1x1', '2x1', '1x2', '2x2'])).min(1),
              destination: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .max(8),
      }),
      execute: async ({ fragmentId, widgets }) => {
        const manifest = await setFragmentWidgets(fragmentId, widgets)
        if (!manifest) return notFound(fragmentId)
        return manifest.widgets.length === 0
          ? 'The fragment no longer offers widgets.'
          : `Declared ${manifest.widgets.length} widget(s): ${manifest.widgets
              .map((w) => `${w.id} (${w.sizes.join(', ')})`)
              .join('; ')}. The person chooses whether and where to place them.`
      },
    }),

    fragment_set_http: tool({
      description: `Declares the hosts the fragment reaches with orbit.http.fetch (up to ${FRAGMENT_MAX_HOSTS}, bare DNS names such as "api.open-meteo.com" — no IPs, no localhost, no wildcards, https only). This only ASKS: the user sees the list and must allow it. Adding hosts later withdraws the allowance, so declare every host the page needs at once. An empty list stops asking.`,
      inputSchema: z.object({ fragmentId: FragmentIdSchema, hosts: z.array(z.string()).max(FRAGMENT_MAX_HOSTS) }),
      execute: async ({ fragmentId, hosts }) => {
        const declared = await setFragmentHosts(fragmentId, hosts)
        if (!declared) return notFound(fragmentId)
        const manifest = await setRequested(fragmentId, 'http', declared.hosts.length > 0)
        panelFragmentOpen({ id: fragmentId, title: declared.name, sessionId })
        const dropped = hosts.length - declared.hosts.length
        const note = dropped > 0 ? ` ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} refused (not a public DNS name, or duplicate).` : ''
        return declared.hosts.length === 0
          ? `orbit.http is no longer requested.${note}`
          : `Declared: ${declared.hosts.join(', ')}.${note} The user must allow "http" in the tab before orbit.http.fetch works (${manifest?.grants.includes('http') ? 'already allowed' : 'not yet'}).`
      },
    }),

    fragment_set_mcp: tool({
      description:
        'Declares which tools of which MCP servers the fragment calls with orbit.mcp.call. Server names and tool names are exactly as Orbit connected them (the tool name WITHOUT the "<server>_" prefix). This only ASKS: the user sees the list and must allow it; adding pairs later withdraws the allowance. An empty list stops asking.',
      inputSchema: z.object({
        fragmentId: FragmentIdSchema,
        access: z.array(z.object({ server: z.string(), tools: z.array(z.string()).min(1) })).max(8),
      }),
      execute: async ({ fragmentId, access }) => {
        const declared = await setFragmentMcp(fragmentId, access)
        if (!declared) return notFound(fragmentId)
        await setRequested(fragmentId, 'mcp', declared.mcp.length > 0)
        panelFragmentOpen({ id: fragmentId, title: declared.name, sessionId })
        if (declared.mcp.length === 0) return 'orbit.mcp is no longer requested.'
        const missing = declared.mcp.flatMap(({ server, tools }) => {
          const live = listMcpServerToolNames(server)
          if (live === null) return [`${server} (not connected)`]
          return tools.filter((t) => !live.includes(t)).map((t) => `${server}/${t} (no such tool)`)
        })
        const connected = listMcpServerNames()
        const warn = missing.length ? ` Not usable right now: ${missing.join(', ')}. Connected servers: ${connected.join(', ') || 'none'}.` : ''
        return `Declared. The user must allow "mcp" in the tab before orbit.mcp.call works.${warn}`
      },
    }),

    fragment_open: tool({
      description: 'Opens (or focuses) an existing fragment in the side panel so the person sees it.',
      inputSchema: z.object({ fragmentId: FragmentIdSchema }),
      execute: async ({ fragmentId }) => {
        const manifest = await getFragment(fragmentId)
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return `Opened "${manifest.name}" (revision ${manifest.revision}).`
      },
    }),

    fragment_read_data: tool({
      description:
        'Reads what a fragment saved with orbit.store (its data, never its code). Read-only. Without `key` it lists the keys with their size; with `key` it returns that value (long values are cut).',
      inputSchema: z.object({ fragmentId: FragmentIdSchema, key: z.string().optional() }),
      execute: async ({ fragmentId, key }) => {
        if (!(await getFragment(fragmentId))) return notFound(fragmentId)
        const data = await readFragmentData(fragmentId)
        if (key === undefined) {
          const keys = Object.entries(data).map(([k, v]) => ({ key: k, bytes: Buffer.byteLength(JSON.stringify(v), 'utf8') }))
          return keys.length === 0 ? 'Nothing saved yet.' : keys
        }
        if (!Object.prototype.hasOwnProperty.call(data, key)) return `No such key: ${key}`
        const text = JSON.stringify(data[key], null, 2)
        return text.length > MAX_READ_DATA_CHARS ? `${text.slice(0, MAX_READ_DATA_CHARS)}\n[… cut: ${text.length - MAX_READ_DATA_CHARS} more characters]` : text
      },
    }),

    fragment_list: tool({
      description: 'Lists the fragments that exist (id, name, kind, last change, what each asked for and what the user allowed), newest first.',
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listFragments()
        if (all.length === 0) return 'There are no fragments yet.'
        return all.map((m) => ({
          fragmentId: m.id,
          name: m.name,
          kind: m.kind,
          updatedAt: new Date(m.updatedAt).toISOString(),
          asked: m.requests,
          allowedByUser: m.grants,
        }))
      },
    }),
  }
}
