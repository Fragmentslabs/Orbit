import path from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { dataDir } from '../storage'
import { isMcpServerName } from '../mcp'
import { computerRegistry } from '../computer/registry'
import { approvalKey, isBrowserId, isDeniedQuery } from '../computer/safety'
import type { PermissionClaim } from '@shared/chat'
import { tNow } from '../i18n'

export interface Assessment {
  claim: PermissionClaim
  ruleId: string
  /**
   * Asks even in full permission mode and ignores "always allow":
   * destructive actions the user needs to see one by one.
   */
  alwaysAsk?: boolean
}

function shorten(text: string, max = 80): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/**
 * Orbit's native (first-party) tools. The MCP catch-all uses "_" as the
 * server separator — native tools in snake_case (show_image, panel_*,
 * memory_*, browser_*, bash_background/list/kill/output, create_skill) would fall into it
 * and ask permission on every call. This allowlist guarantees that native
 * ones are NEVER evaluated as MCP. The ones that deserve evaluation (bash, write,
 * edit) have their own rules in assess() — the rest approves without asking.
 * Beyond the allowlist, the user can extend "never ask" via
 * permissions.json (neverAsk field) — see loadUserNeverAsk().
 */
const NATIVE_TOOLS = new Set([
  // Right panel browser
  'panel_navigate',
  'panel_read',
  'panel_click',
  'panel_type',
  'panel_resize',
  'panel_screenshot',
  'panel_console',
  'panel_hover',
  'panel_drag',
  // Runs JS in the panel browser page: same threat model as
  // run_browser_script (the agent already runs arbitrary code), and the page is
  // the one the agent itself opened.
  'panel_eval',
  'show_image',
  // HTML artifacts shown in the response. They do not ask permission: they write only to
  // Orbit's storage (orbit-data/artifacts), never to the user's project, and
  // they run in a sandboxed iframe with no access to the app — the threat model is that of
  // any web page, not that of bash.
  'create_artifact',
  'update_artifact',
  // Query of the documents attached to the conversation: pure read of the text the
  // user themselves attached, already persisted in Orbit's storage.
  'doc_list',
  'doc_search',
  'doc_read',
  'pdf_view_page',
  // Spreadsheet query: pure read, with no writing anywhere
  'sheet_query',
  // Deliverable documents: they write to Orbit's storage
  // (orbit-data/documents), never to the user's project.
  'create_document',
  'update_document',
  'read_document',
  'list_documents',
  // .docx editing: writes a COPY to Orbit's storage. Writing to the user's
  // project only happens with savePath, which the tool itself restricts to an
  // explicit request — same convention as panel_screenshot.
  'docx_edit',
  'docx_paragraphs',
  // PDF operations: they generate a NEW file in Orbit's storage; writing to the
  // project only with savePath, restricted to an explicit request.
  'pdf_merge',
  'pdf_transform',
  'pdf_form_fields',
  'pdf_form_fill',
  'pdf_metadata',
  'pdf_extract_images',
  // Image editing: pixel processing over what is already in the gallery or
  // in the working folder, with the output going to Orbit's storage. Writing to the
  // project only with savePath, restricted to an explicit request — same convention as
  // pdf_transform and docx_edit.
  'image_list',
  'image_info',
  'image_edit',
  // Gallery cleanup: deletes images the AGENT produced, including from
  // earlier turns. The lock is the origin — a user attachment is refused by the
  // tool itself —, not the turn; same pattern as memory_delete.
  'image_delete',
  // SVG: same convention. Editing is text, not pixel, but the delivery is the same —
  // a new file in the gallery, the user's project only with savePath.
  'svg_vectorize',
  'svg_create',
  'svg_info',
  'svg_edit',
  // Audio: generating writes the audio to Orbit's storage — in the project only with
  // savePath, restricted to an explicit request. Same convention as the image ones.
  // (Transcribing is `transcribe`, listed along with the video ones.)
  'audio_generate',
  // Overlay: reading the screen and the selection of the front app is what the person asked for
  // when opening the panel; ending the call is the "bye, Orbit". Neither writes.
  'see_screen',
  'see_window_text',
  'see_selection',
  'end_call',
  // Batch automation in the hidden engine (same threat model as bash: the agent
  // already runs arbitrary code; the script runs isolated in a utilityProcess)
  'run_browser_script',
  'capture_batch',
  // Recording a script: it navigates in a hidden window with the SAME browser
  // tools already released above and records the framebuffer. It does not ask for
  // system recording permission (CDP captures the page, not the screen) and does not write to the
  // project — the MP4 goes to Orbit's gallery.
  'browser_record',
  // Chat mode browser (the "Browser" toggle) — native tools of the toggle,
  // not MCP; they fell into the "_" catch-all and asked permission as the "browser" server
  'browser_open',
  'browser_links',
  // Memory (brain)
  'memory_save',
  'memory_search',
  'memory_open',
  'memory_graph',
  // memory_link and memory_tree exist in both modes (links between memories
  // and reading the tree skeleton); they also fell into the catch-all as the
  // "memory" server
  'memory_link',
  'memory_tree',
  // In-place review of a memory — same threat model as memory_save
  'memory_update',
  // Memory maintenance: listing by disuse and deleting. Native because the data
  // belongs to the agent itself (summaries it wrote); the lock on delete is the
  // deliberation the tool requires (written reason), not a permission box.
  'memory_list',
  'memory_delete',
  // Chat maintenance — the cleanup routines depend on them. chat_delete is
  // irreversible: the protection lives in the tool itself (refuses pinned ones, limit per
  // call, mandatory reason) and in the description, which says to prefer archiving.
  'chat_list',
  'chat_archive',
  'chat_delete',
  // Subchats: reading a child's conversation is a pure read of Orbit's storage.
  // Instructing one (send_to_subchat) has its own rule in assess().
  'read_subchat',
  // Usage reports (pure read of the history itself): hours per project,
  // cost and tokens. Native — without this they fall into the MCP catch-all as the
  // 'work'/'usage' server and ask permission on every call.
  'work_report',
  'usage_stats',
  // Background processes
  'bash_background',
  'bash_list',
  'bash_kill',
  'bash_output',
  // Chat worktrees: listing, creating and switching the folder are reversible (the
  // worktree_remove stays out: it always asks for confirmation — see assess)
  'worktree_list',
  'worktree_create',
  'worktree_switch',
  // Pipeline (task board)
  'pipeline_create',
  'pipeline_list',
  'pipeline_create_task',
  'pipeline_task_status',
  // Vision mode: describes attached images with the configured vision model
  // (pure read, first-party) — it fell into the MCP catch-all as the
  // "describe" server and asked permission on every call.
  'describe_image',
  // Skills
  'create_skill',
  // Turn state (read, first-party): verify_changes checks what was
  // written in the turn; session_context brings metadata of recent turns.
  // They fell into the MCP catch-all ("verify"/"session") and asked permission on
  // every call — which made the model skip the check.
  'verify_changes',
  'session_context',
  // Code index (code-index): pure read of the project, same threat model
  // as read/grep — which never asked. They would fall into the MCP catch-all if there were
  // a server called "code".
  'code_search',
  'code_outline',
  'code_refs',
  // MCP connections (mcp_connect/mcp_update/mcp_servers): they only PROPOSE — the connection
  // comes into existence when the user accepts in the conversation card, and it is the card
  // that writes. Without entering this list they fell into the MCP catch-all as if
  // they belonged to the "mcp" server, asking permission on every call exactly
  // so that the user could then decide in the card.
  'mcp_connect',
  'mcp_update',
  'mcp_servers',
  // Video and motion (panel pieces): the engine runs LOCALLY, and the delivery is a
  // file — in Orbit's storage or at the destination the user themselves chooses
  // (the tab's render goes through a system save dialog). Same threat
  // model as the image and audio ones, which were already here. Without entering this list,
  // motion_preview and company fell into the MCP catch-all as the "motion" server
  // and asked permission on every call.
  'motion_preview',
  'motion_write',
  'motion_edit',
  'motion_read',
  'motion_render',
  'motion_asset',
  'motion_delete',
  // Design (artboard canvas in the panel): same threat model — local engine,
  // the delivery is a file in Orbit's storage. Without entering here it would fall into the
  // MCP catch-all as the "design" server and ask permission on every call.
  'design_write',
  'design_edit',
  'design_read',
  'design_preview',
  'design_asset',
  'design_delete',
  // Slides (deck in the panel): same threat model as design — the deck is a file
  // assembled in the app's storage. Outside this list it would fall into the MCP catch-all as the
  // "slides" server and ask permission on every call.
  'slides_preview',
  'slides_write',
  'slides_edit',
  'slides_read',
  'slides_asset',
  'slides_delete',
  // Searching and importing an image from an open collection (Commons, Openverse): only read
  // network traffic to two known providers, and the file lands in the app's storage.
  'image_search',
  'image_import',
  'motion_frame',
  'show_video',
  'video_guide',
  'video_probe',
  'transcribe',
  'video_timeline',
  'video_render',
  // Media by link (yt-dlp): reading a public page and writing to
  // Orbit's storage (chat) or to downloads/ in the working folder (code) —
  // the same threat model as media_compress and webfetch, which also do not ask
  // permission. install only downloads the official binary, with a checksum, into the
  // app's folder.
  'ytdlp_info',
  'ytdlp_download',
  'ytdlp_transcript',
  'ytdlp_install',
  // Computer Use — read: listing apps, observing (screenshot + tree), searching
  // and seeing permissions. They only exist with the Preferences switch AND the
  // conversation mode on, and the denylist applies here too (isForbidden). Acting
  // (cu_computer) goes through the gate — see assessComputer.
  'cu_apps',
  'cu_observe',
  'cu_query',
  // Checking reads the tree like cu_observe and only sends the text to an
  // auxiliary model — nothing on the screen changes.
  'cu_verify',
  'cu_permissions',
  // Delegates to a subagent: its actions go through the gate one by one (per app).
  'computer_task',
  'cu_record_start',
  'cu_record_mark',
  'cu_record_stop',
])

/**
 * Acting on the screen: approval per app (per site, in browsers). Like every
 * request, "Allow" holds for the turn, "Always in this chat" for the conversation and
 * "Always" for this app (or site) from now on. The detail shows the app,
 * the window/URL seen and the action, so the user knows what they are releasing.
 */
function assessComputer(args: Record<string, unknown>): Assessment | null {
  const action = typeof args.action === 'string' ? args.action : '?'
  if (action === 'wait') return null
  const query = typeof args.app === 'string' ? args.app : ''
  const target = query ? computerRegistry.lastTargetFor(query) : null
  const app = target?.bundleId ?? (query || '?')
  const name = target?.name ?? (query || '?')
  const ruleId = approvalKey(app, target?.url)
  const host = ruleId.includes('@') ? ruleId.split('@')[1] : null
  // Browser with no known site (Windows UIA has no URL): the approval
  // holds for the whole browser, and the user needs to know that.
  const wholeBrowser = !host && isBrowserId(app)
  const what =
    action === 'type' || action === 'set_value'
      ? `${action}: ${shorten(String(args.text ?? ''), 60)}`
      : action === 'key'
        ? `key: ${String(args.key ?? '')}`
        : action === 'open_app'
          ? tNow('perm.bringToFront')
          : action === 'batch'
            ? tNow('perm.batchCount', { count: String(args.batchSteps ?? '?') })
          : args.element !== undefined
            ? `${action} no elemento ${String(args.element)}`
            : `${action}${args.x !== undefined ? ` em (${String(args.x)}, ${String(args.y)})` : ''}`
  return {
    ruleId,
    claim: {
      tool: 'cu_computer',
      title: host ? tNow('perm.control.withHost', { app: name, host }) : tNow('perm.control.plain', { app: name }),
      detail:
        `O agente quer agir no app ${name}${host ? ` (site ${host})` : ''} — ${what}. ` +
        tNow('perm.approvalThisApp') + (host ? ' e este site' : '') + '; outro app ou outro site pede de novo.' +
        (wholeBrowser ? tNow('perm.approvalAllTabs') : ''),
    },
  }
}

const USER_RULES_FILE = () => path.join(dataDir(), 'permissions.json')

let cachedNeverAskMtime = -1
let cachedNeverAsk: Set<string> | null = null

/**
 * The user's "never ask permission" list, read from permissions.json
 * (same directory as mcp-config.json). Format:
 *   { "neverAsk": ["bash", "write", "edit", "websearch"] }
 * Missing or invalid file = empty list. Cached by mtime so that
 * assess() (called on every tool call) does not do unnecessary I/O.
 */
function loadUserNeverAsk(): Set<string> {
  try {
    const file = USER_RULES_FILE()
    const mtime = statSync(file).mtimeMs
    if (cachedNeverAsk && mtime === cachedNeverAskMtime) return cachedNeverAsk
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as { neverAsk?: unknown }
    cachedNeverAsk = new Set(
      Array.isArray(parsed.neverAsk) ? parsed.neverAsk.filter((t): t is string => typeof t === 'string') : [],
    )
    cachedNeverAskMtime = mtime
  } catch {
    cachedNeverAsk = new Set()
    cachedNeverAskMtime = -1
  }
  return cachedNeverAsk
}

function isCriticalTarget(target: string, dir: string): boolean {
  const clean = target.replace(/["']/g, '')
  if (clean === '/' || clean === '~' || clean === '.' || clean === '..' || clean === '*') return true
  if (/^[A-Za-z]:[\\/]?$/.test(clean)) return true
  if (clean.startsWith('~')) return true
  if (path.isAbsolute(clean)) return true
  const resolved = path.resolve(dir, clean)
  const rel = path.relative(dir, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function segments(command: string): string[][] {
  return command
    .split(/(?:\|\||&&|;|\|)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/))
}

function assessBash(command: string, dir: string | null): Assessment | null {
  const found: Assessment[] = []
  const claim = (ruleId: string, detail: string): Assessment => ({
    ruleId,
    claim: { tool: 'bash', title: `bash: ${shorten(command)}`, detail },
  })

  for (let tokens of segments(command)) {
    if (tokens[0] === 'sudo') {
      found.push(claim('bash:sudo', tNow('perm.risk.elevated')))
      tokens = tokens.slice(1)
    }
    const cmd = tokens[0]

    if (cmd === 'rm') {
      const flags = tokens.filter((t) => t.startsWith('-')).join('')
      const recursiveForce = /r/i.test(flags) && flags.includes('f')
      if (recursiveForce) {
        const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
        if (targets.some((t) => isCriticalTarget(t, dir ?? ''))) {
          found.push(claim('bash:rm-rf-critical', tNow('perm.risk.recursiveRemoveOutside')))
        } else {
          found.push(claim('bash:rm-rf', tNow('perm.risk.recursiveRemove')))
        }
      }
    }

    if (cmd === 'git') {
      const sub = tokens[1]
      if (sub === 'push') {
        const force = tokens.some((t) => t === '--force' || t === '-f')
        found.push(
          force
            ? claim('bash:git-push-force', tNow('perm.risk.forcePush'))
            : claim('bash:git-push', 'publica commits no remoto (git push)'),
        )
      }
      if (sub === 'reset' && tokens.includes('--hard')) {
        found.push(claim('bash:git-reset-hard', tNow('perm.risk.hardReset')))
      }
    }

    // Screen control through bash: osascript with System Events (keystroke,
    // click, key code) drives any app outside Computer Use — without the
    // denylist, without the per-app approval, without the password-field refusal.
    if (cmd === 'osascript' && /system events|keystroke|key code|click at/i.test(command)) {
      found.push(claim('bash:gui-automation', tNow('perm.risk.osascript')))
    }
    // Windows: PowerShell with SendKeys/SendInput/UI Automation does the same outside it.
    if (/^(powershell|pwsh)(\.exe)?$/.test(cmd) && /sendkeys|sendinput|mouse_event|keybd_event|system\.windows\.automation|uiautomation/i.test(command)) {
      found.push(claim('bash:gui-automation', tNow('perm.risk.powershell')))
    }

    if (cmd.startsWith('npx') || cmd.startsWith('npm') || cmd.startsWith('pnpm') || cmd.startsWith('yarn') || cmd.startsWith('bun')) {
      const install = tokens.some((t) => t === 'install' || t === 'add' || t === 'remove' || t === 'link')
      if (install) {
        found.push(claim('bash:package-install', tNow('perm.risk.dependencies')))
      }
    }
  }

  if (found.length === 0) return null
  return found[found.length - 1]
}

function assessFileWrite(tool: string, filePath: string): Assessment | null {
  const normalized = filePath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized.toLowerCase())

  const claim = (ruleId: string, detail: string): Assessment => ({
    ruleId,
    claim: { tool, title: `${tool}: ${shorten(filePath, 60)}`, detail },
  })

  if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) {
    return claim('file:git-dir', tNow('perm.risk.gitWrite'))
  }
  if (/^\.env(\..+)?$/.test(base)) {
    return claim('file:env', tNow('perm.risk.envFile'))
  }
  const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
  if (LOCKFILES.has(base)) {
    return claim('file:lockfile', tNow('perm.risk.lockfile'))
  }
  return null
}

export function assess(toolName: string, input: unknown, dir: string | null): Assessment | null {
  const args = (input ?? {}) as Record<string, unknown>
  // "Never ask": allowlist of native tools + the user's configurable list
  // (permissions.json → neverAsk). The check comes before the risk rules:
  // whoever put the tool here wants execution without a question — isForbidden
  // (hard block) still applies on top of that.
  if (NATIVE_TOOLS.has(toolName) || loadUserNeverAsk().has(toolName)) return null
  if (toolName === 'bash' && typeof args.command === 'string') {
    return assessBash(args.command, dir)
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    return assessFileWrite(toolName, args.filePath)
  }
  if (toolName === 'cu_computer') return assessComputer(args)
  // Batch: the same per-app approval, with the number of steps in the detail.
  if (toolName === 'cu_batch') {
    const steps = Array.isArray(args.steps) ? args.steps.length : 0
    return assessComputer({ ...args, action: 'batch', batchSteps: steps })
  }
  // Removing a worktree deletes the folder and whatever was not committed in it: it always
  // asks, even in full mode (the rule from the worktrees plan for chats).
  if (toolName === 'worktree_remove') {
    const target = typeof args.target === 'string' ? args.target : '?'
    return {
      ruleId: 'worktree:remove',
      alwaysAsk: true,
      claim: {
        tool: toolName,
        title: tNow('perm.worktree.remove', { name: shorten(target, 60) }),
        detail:
          tNow('perm.worktree.removeDetail') +
          (args.deleteBranch === true ? tNow('perm.worktree.branchDeleted') : tNow('perm.worktree.branchKept')),
      },
    }
  }
  // Instructing a subchat makes another conversation work (and write in the folder) in
  // parallel: the user needs to see what is going to be sent. It is the usual
  // permission card — "allow" holds for the turn; in unrestricted mode it goes
  // straight through. read_subchat only reads (it is in NATIVE_TOOLS) and open_subchat does not
  // ask here: what confirms is the suggestion card (suggest_subchat), or the
  // user's own request ("do it in a new chat").
  if (toolName === 'send_to_subchat') {
    const message = typeof args.message === 'string' ? args.message : ''
    return {
      ruleId: 'subchat:send',
      claim: {
        tool: toolName,
        title: tNow('perm.subchat.sendInstruction'),
        detail: shorten(message, 300),
      },
    }
  }
  // "_" catch-all for MCP servers (Nodara_*, N8N_-_Vlk_*, ...) — but only
  // when the prefix is a REALLY configured server. Native tools in
  // snake_case also have "_": without this check, motion_preview, video_render,
  // audio_generate and pdf_merge asked permission as "Tool from MCP server
  // motion" — the user had to approve the tool itself on every call.
  if (toolName.includes('_')) {
    const serverName = toolName.split('_')[0]
    if (isMcpServerName(serverName)) {
      return {
        ruleId: `mcp:${serverName}`,
        claim: {
          tool: toolName,
          title: toolName,
          detail: tNow('perm.mcp.tool', { server: serverName }),
        },
      }
    }
  }
  return null
}

export function isForbidden(toolName: string, input: unknown, dir: string | null): boolean {
  const args = (input ?? {}) as Record<string, unknown>

  if (toolName === 'bash' && typeof args.command === 'string') {
    const command = args.command
    for (const tokens of segments(command)) {
      const cmd = tokens[0]
      if (cmd === 'rm') {
        const flags = tokens.filter((t) => t.startsWith('-')).join('')
        const recursiveForce = /r/i.test(flags) && flags.includes('f')
        if (recursiveForce) {
          const targets = tokens.slice(1).filter((t) => !t.startsWith('-'))
          if (targets.some((t) => isCriticalTarget(t, dir ?? ''))) return true
        }
      }
    }
  }

  if ((toolName === 'write' || toolName === 'edit') && typeof args.filePath === 'string') {
    const normalized = args.filePath.replace(/\\/g, '/')
    if (/(^|\/)\.git(\/|$)/.test(normalized.toLowerCase())) return true
  }

  // Password vaults, system settings and security prompts: neither observing
  // nor acting — in any permission mode. The tool checks again after
  // resolving the app (the model may send a pid); this is the first barrier.
  if (toolName.startsWith('cu_') && typeof args.app === 'string' && isDeniedQuery(args.app)) return true

  return false
}
