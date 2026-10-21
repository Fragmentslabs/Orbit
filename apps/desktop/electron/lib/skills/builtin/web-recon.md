---
name: Web Recon
description: Map and extract a website with the built-in browser (routes, rendered HTML, CSS, assets, API calls, screenshots) for research, documentation, testing, migration or rebuilding a UI the user has the rights to.
slug: web_recon
---

# Web Recon

Use when the user asks to map, crawl, document, test or rebuild a site. The engine is the
hidden Electron browser (`run_browser_script` / `capture_batch`) — not Playwright — and it
shares the panel browser's cookies and session.

**Not this skill:** if the user owns the app and wants screenshot documentation of its
screens, that is the `/document` flow (it reads the routes from the code and writes
`docs/<page>/README.md` with the images). Use this skill when the site is a black box —
you don't have its code and need what it renders, serves and calls.

## Rules

- Crawl only sites the user owns, has written permission for, or that allow it. Check
  `robots.txt` and the site's Terms; when in doubt, ask.
- Never bypass authentication, paywalls, MFA, rate limits or DRM.
- If the user has legitimate access, the cleanest path is: they sign in in the panel
  browser (`panel_navigate` + `panel_type`), and the hidden engine reuses that session.
  If the user explicitly hands over credentials, use them only in the login form for that
  session — never write them into artifacts, logs, memory or the final answer. When MFA
  is required, stop and ask the user to complete it in the panel.
- Keep the crawl bounded: same origin, a max page count, a max depth and a delay between
  requests. Stop on 401/403/429 and report instead of pushing harder.
- Copyright: HTML, CSS, text, images and code are evidence, not a license. Do not ship or
  republish them without rights. Record `provenance.json` (source URL + date).
- Personal data: collect only what the task needs and redact it from the saved artifacts.

## 1. Scope first

Ask once (one round) for: the start URL, the pages/sections in scope, whether auth is
needed, the output folder and the goal (docs, testing, migration, rebuild). If the goal
is a rebuild, confirm the user has the rights to that UI, brand and content.

## 2. Crawl

`run_browser_script` with `outDir` (relative to the working folder). The loop runs in the
engine, not in the model context — one tool call can walk dozens of pages. This is a
starting recipe; adapt the selectors and the scope to the site:

```js
const START = 'https://example.com'
const MAX = 40, DEPTH = 3, DELAY = 400
const origin = new URL(START).origin
const seen = new Set([START])
const queue = [{ url: START, depth: 0 }]
const index = []

while (queue.length && index.length < MAX) {
  const { url, depth } = queue.shift()
  await orbit.goto(url)
  await orbit.wait(300)
  const page = await orbit.evaluate(() => ({
    title: document.title,
    url: location.href,
    html: document.documentElement.outerHTML,
    text: document.body?.innerText ?? '',
    links: [...document.querySelectorAll('a[href]')].map((a) => a.href),
    stylesheets: [...document.styleSheets].map((s) => s.href).filter(Boolean),
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
    resources: performance.getEntriesByType('resource').map((e) => ({ url: e.name, type: e.initiatorType })),
  }))
  const slug = page.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
  await orbit.save(`pages/${slug}.json`, page)
  index.push({ url: page.url, title: page.title, file: `pages/${slug}.json` })
  if (depth < DEPTH) {
    for (const href of page.links) {
      const u = new URL(href)
      u.hash = ''
      if (u.origin === origin && !seen.has(u.href)) {
        seen.add(u.href)
        queue.push({ url: u.href, depth: depth + 1 })
      }
    }
  }
  await orbit.wait(DELAY)
}

await orbit.save('index.json', index)
return { pages: index.length, queued: queue.length }
```

Run it as `run_browser_script({ script, outDir: '.orbit/recon/<site>', timeoutMs: 600000 })`.

- More than ~40 pages: split by section, or save `{ seen, queue }` and resume in another call.
- `capture_batch` takes up to 50 screenshots per call; `orbit.capture(name, { fullPage: true })`
  inside a script saves one image per route. Images never enter the model context.
- One page, with interaction: `panel_navigate` → `panel_read` → `panel_click`/`panel_type`.
- `webfetch` is the cheap path for static HTML (no JS rendering).

## 3. What to collect

- Routes: `a[href]`, `location.pathname`, `sitemap.xml`, `robots.txt`.
- Rendered DOM plus computed styles of key elements (color, font, spacing, breakpoints) —
  a rebuild needs the styles, not just `innerText`.
- CSS: stylesheet `href`s and inline rules (`document.styleSheets` → `cssRules`, wrapped in
  try/catch for cross-origin sheets).
- Assets: images, fonts, icons, video; `performance.getEntriesByType('resource')`.
- JS bundles and source maps: the `src` of every script; pull them with `orbit.fetch` and
  search for routes and API endpoints. Minified bundles are not the original source.
- API surface: resource entries with `initiatorType` `fetch`/`xmlhttprequest`; probe them
  with `orbit.fetch` (same cookies) and save the responses.
- Screenshots of the key routes, saved through `orbit.capture` / `capture_batch`.

## 4. Rebuild (only with rights)

Appearance and behavior can be reconstructed; the original React source cannot (JSX,
components, state and props are not recoverable). Build:

1. `index.json` + the route map → the new router.
2. Repeated DOM patterns → component inventory; computed styles → design tokens.
3. Assets → the project's public folder (check each license).
4. API calls → a new client; compare the responses.
5. Implement from scratch and compare screenshots per route and viewport, iterating.

Never copy proprietary text, logos or images into the new project without permission.
Keep `provenance.json` with the source, the date and the licenses.

## 5. Stop and ask

Stop and ask the user when: a login wall appears, 401/403/429 persists, robots/ToS
disallow the crawl, the scope is unclear, or the request is to clone third-party
content without rights.
