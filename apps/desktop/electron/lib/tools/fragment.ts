import { tool } from 'ai'
import { z } from 'zod'
import {
  clearFragmentLogs,
  createFragment,
  deleteFragmentFile,
  getFragment,
  listFragmentFiles,
  listFragments,
  readFragmentFile,
  readFragmentLogs,
  requestCapabilities,
  writeFragmentFile,
} from '../fragments/fragment-store'
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
- orbit.theme ("light" | "dark") and orbit.on("theme", fn) — the app theme. The Orbit CSS variables are already defined and follow it: --background, --foreground, --card, --card-foreground, --primary, --primary-foreground, --secondary, --muted, --muted-foreground, --accent, --border, --input, --ring, --radius and --font-sans. Style with them (e.g. body { background: var(--background) }) so the screen looks native in light and dark.
Errors from orbit calls carry err.code.

Hard limits of the page (a closed sandbox): NO network of any kind — no fetch to the internet, no CDN scripts, no external images, fonts or iframes. Write plain HTML/CSS/JavaScript (ES modules between your own files are fine); draw charts with inline SVG or <canvas>. Files: index.html is the entry; add style.css, app.js, etc. with fragment_write_file and reference them relatively (<link href="style.css">, <script src="app.js">). Allowed file types: html, css, js, mjs, json, svg, txt, csv, md.
After writing, the panel reloads by itself. Call fragment_logs to read the page's console and errors and fix what is broken.`

const CREATE_DESCRIPTION = `Creates a FRAGMENT: a small interactive screen that opens in the side panel next to the chat and that the user can keep using — a tool, tracker, dashboard, mini-app or utility, not a one-off illustration of an answer (for that, create_artifact). It is saved, shows up again later, and can store data and ask Orbit's model through window.orbit. Send a complete index.html (inline CSS/JS is fine, or split into files afterwards). From then on, keep refining it with fragment_edit_file / fragment_write_file as the user asks: the panel reloads on every write, so they watch it change live.
${SDK_REFERENCE}`

const FragmentIdSchema = z.string().describe('The fragmentId returned by fragment_create (frag-…)')

function notFound(id: string): string {
  return `Fragment not found: ${id}. List the existing ones with fragment_list or create a new one with fragment_create.`
}

export function createFragmentTools(sessionId: string) {
  /** Opens/focuses the tab and builds the part of the result that is the same everywhere. */
  async function opened(id: string, revision: number, lead: string): Promise<string> {
    const manifest = await getFragment(id)
    if (manifest) panelFragmentOpen({ id, title: manifest.name, sessionId })
    const aiNote =
      manifest && manifest.requests.includes('ai') && !manifest.grants.includes('ai')
        ? ' This fragment uses orbit.ai: it works only after the user turns on "AI" in the tab toolbar — tell them so.'
        : ''
    return `${lead} (revision ${revision}). The person is looking at it live (on the Fragments page, or in a Fragment tab of the side panel) and it reloads on every write.${aiNote} Call fragment_logs to check the page for runtime errors.`
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
          .enum(['screen', 'panel', 'widget'])
          .optional()
          .describe(
            'Where it is meant to live. "screen" (default): a full page of the app. "panel": a compact tab of the side panel, designed for a narrow column. "widget": a small card for the home screen (keep it tiny and glanceable). Use the kind the user asked for; it changes how much room the layout has.',
          ),
        usesAi: z
          .boolean()
          .optional()
          .describe('true when the page calls orbit.ai.generate — the user will be asked to allow it'),
      }),
      execute: async ({ name, html, icon, kind, usesAi }) => {
        try {
          const manifest = await createFragment({ name, html, icon, kind, requests: usesAi ? ['ai'] : [], sessionId })
          return {
            fragmentId: manifest.id,
            message: await opened(manifest.id, manifest.revision, `Fragment "${manifest.name}" created`),
          }
        } catch (err) {
          return `Could not create the fragment: ${err instanceof Error ? err.message : String(err)}`
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
          const manifest = await writeFragmentFile(fragmentId, rel, content)
          return await opened(fragmentId, manifest.revision, `Wrote ${rel}`)
        } catch (err) {
          return `Could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`
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
        const current = await readFragmentFile(fragmentId, rel)
        if (current === null) return `File not found in the fragment: ${rel}. See fragment_read_file for the file list.`
        try {
          const { text, applied } = applyTextEditsDetailed(current, edits)
          const manifest = await writeFragmentFile(fragmentId, rel, text)
          return await opened(fragmentId, manifest.revision, `Edited ${rel} (${applied.length} edit${applied.length === 1 ? '' : 's'})`)
        } catch (err) {
          return `Could not edit ${rel}: ${err instanceof Error ? err.message : String(err)}`
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
          const manifest = await deleteFragmentFile(fragmentId, rel)
          return await opened(fragmentId, manifest.revision, `Removed ${rel}`)
        } catch (err) {
          return `Could not remove ${rel}: ${err instanceof Error ? err.message : String(err)}`
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
        const manifest = await requestCapabilities(fragmentId, usesAi ? ['ai'] : [])
        if (!manifest) return notFound(fragmentId)
        panelFragmentOpen({ id: fragmentId, title: manifest.name, sessionId })
        return usesAi
          ? 'Declared. The user must turn on "AI" in the tab toolbar before orbit.ai.generate works.'
          : 'orbit.ai is no longer requested by this fragment.'
      },
    }),

    fragment_list: tool({
      description: 'Lists the fragments that exist (id, name, last change), newest first.',
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listFragments()
        if (all.length === 0) return 'There are no fragments yet.'
        return all.map((m) => ({ fragmentId: m.id, name: m.name, updatedAt: new Date(m.updatedAt).toISOString() }))
      },
    }),
  }
}
