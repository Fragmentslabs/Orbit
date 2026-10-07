<p align="center">
  <img src="docs/images/orbit-logo.png" alt="Orbit" width="120" />
</p>

# Orbit

**Orbit is an AI coding agent for desktop and mobile.** Work directly with your codebase, delegate tasks to specialized subagents, orchestrate multi-agent workflows, and continue conversations from anywhere through the mobile companion app — with any model, from any provider.

A GUI for AI coding agents — like [OpenAI Codex](https://openai.com/codex/) and [Claude Desktop](https://claude.ai/download) — with two things they don't combine: **total provider freedom** (bring your own model, from Anthropic to local open-weight models, like opencode) and a **mobile companion app** (same sessions on the go, like Codex and Claude Desktop). The agent engine runs locally on your machine, and you decide exactly how much autonomy it gets — from "ask before every action" to full autonomy.

> Orbit is an independent project — not affiliated with, endorsed by, or connected to OpenAI or Anthropic. *Codex* is a trademark of OpenAI; *Claude* is a trademark of Anthropic.
>
> Part of the [Fragments Labs](https://ko-fi.com/fragmentslabs) ecosystem.

---

## 🎯 Why Orbit?

Orbit is designed for developers who want:

- **Local-first workflows** — the agent engine runs on your machine; your code never leaves it except for the model API calls you choose to make
- **Full control over autonomy** — permission modes from "ask before every action" to full autonomy, per chat
- **Multi-agent orchestration** — plan, build, delegate and coordinate multiple agents with their own specialized context
- **Desktop + mobile continuity** — same sessions, memories and preferences on your phone
- **Provider freedom** — any model from any provider, your own keys, even local open-weight models
- **Persistent memory** — an Obsidian-inspired memory graph that learns your preferences and project conventions across sessions
- **Source-available & auditable** — read the code, audit what the agent can do, and change it

Unlike cloud-only coding assistants, Orbit runs locally and lets you decide how much autonomy the agent has.

### Orbit vs other coding assistants

| Feature | Orbit | OpenAI Codex | Claude Code | opencode | Cursor |
|---|---|---|---|---|---|
| Desktop app | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mobile companion | ✅ | ✅ | ✅ | ❌ | ❌ |
| Multi-agent orchestration | ✅ | Partial | Partial | Partial | Partial |
| Provider freedom (any model) | ✅ | ❌ | ❌ | ✅ | Partial |
| Local open-weight models | ✅ | ❌ | ❌ | ✅ | Partial |
| Persistent cross-session memory | ✅ | Partial | Partial | Partial | Partial |
| Source-available code | ✅ | ❌ | ❌ | ✅ | ❌ |

*Capabilities evolve fast — this table reflects v0.1.4; verify before choosing a tool.*

---

## ✨ Features (v0.1.4)

### 🧠 Agent & modes

- **Code mode and Chat mode** — code mode works directly with your projects and folders; chat mode has its own persistent memories and is designed to be more human — a conversation partner that learns from you over time, not just a chatbot
- **Plan / Build / Orchestrate** modes — plan before acting, implement, or orchestrate multi-agent workflows
- **Subagents** — delegate tasks to specialized agents with their own context
- **Reasoning control** — adjustable reasoning levels per task, with lightweight model variants for cheap fast passes
- **Permission modes** — from "ask before every action" to full autonomy, per chat
- **Scheduled messages** — queue prompts to run at a later time
- **Skills** — reusable instruction sets that the agent applies on demand

#### Multi-agent workflows

Delegate work to specialized subagents while the orchestrator coordinates results:

```
Orchestrator agent
├─ Backend agent
├─ Frontend agent
├─ Database agent
└─ Testing agent
```

#### Persistent memory

Orbit's memory system is inspired by **Obsidian**: a persistent graph of memories where the agent stores what it learns about you and your projects — preferences, conventions, decisions — independent of the chat context window. Memories link to related memories, so the agent gets smarter with every session instead of starting from scratch.

### 🔌 Models & providers

- **Multi-provider** — Anthropic, OpenAI, Google (incl. Vertex), Azure, Amazon Bedrock, Cohere, and any OpenAI-compatible endpoint
- **Open-weight models** — run local models (Llama, Qwen, DeepSeek, Mistral…) through any OpenAI-compatible endpoint
- **Live model catalog** (models.dev) with search, pricing, speed and capability badges
- **Custom providers** — bring your own API key or gateway

### 🛠️ Developer tools

- **File tools** — read, write, edit, list, search (with one-click **revert to file snapshots** per message)
- **Integrated terminal** (PTY) with process monitoring
- **Built-in browser panel** — a side browser for you *and* the agent, ideal for testing, validating, documenting, web scraping and research:
  - the agent drives it autonomously (navigate, click, type, screenshot, assert) to test and validate web apps — no vision model required, it works from the page structure
  - **element picker** — select any element on the page to use it as context in the chat
  - **responsive testing** — switch between mobile, tablet and desktop viewports
  - **fullscreen mode** — browse full screen while staying connected to the chat in real time
- **Web search & read** tools for research
- **MCP support** — connect external Model Context Protocol servers
- **Inline diff review** before/after every change
- **Working folders per chat** — attach folders to a chat, with file preview, markdown view/edit toggle and branch switching right from the panel
- **Git integration** — branch selector with inline branch creation

### 📱 Mobile companion

- Pair with your desktop app over the local network (QR code)
- Chat on the go — same sessions, remote
- Manage preferences, providers, tools, memories and notifications from your phone

### 🎨 UI & UX

- Multi-tab right panel (chat, terminal, folders, browser, diff)
- **i18n** — English and pt-BR (more coming)
- Dark/light appearance settings
- Usage analytics and activity heatmap
- File palette, slash commands, and chat search

---

## 🎬 Example

```
User:  Build a user authentication system with Stripe subscriptions.

Orbit:
  ✓ Creates an implementation plan
  ✓ Delegates database design to a DB subagent
  ✓ Delegates API routes to a backend subagent
  ✓ Delegates UI screens to a frontend subagent
  ✓ Reviews the generated code
  ✓ Presents the final diff before applying changes
```

---

## 📦 Download

| Platform | Channel | Link |
|---|---|---|
| Windows | GitHub Releases (installer) | *coming soon* |
| Windows | Microsoft Store | *coming soon* |
| Android | GitHub Releases (.apk) | *coming soon* |
| Android | Google Play | *coming soon* |
| iOS | App Store | *coming soon* |

---

## 🚀 Getting started (development)

**Requirements:** Node.js 20+, npm. On Windows, desktop builds require Visual Studio Build Tools 2022 (workload "Desktop development with C++") — without it, `electron-builder` fails rebuilding native modules (`node-pty`, `ws`).

```bash
# install dependencies (monorepo — npm workspaces)
npm install

# desktop app (Vite + Electron, hot reload)
npm run desktop:dev

# mobile companion (Expo)
npm run mobile:dev
```

Build the desktop installer:

```bash
npm run desktop:build   # outputs to apps/desktop/release/
```

Release a new Linux version — GitHub Actions builds and publishes the AppImage + `.deb` to GitHub Releases automatically:

```bash
# 1. bump the version in apps/desktop/package.json (and the root package.json)
# 2. commit and push, then tag & release:
git tag v0.1.4
git push origin v0.1.4
```

---

## 🧠 How it works

Orbit is a monorepo:

```
apps/desktop   Electron desktop app (React + Vite + Tailwind)
apps/mobile    Expo / React Native companion app
packages/shared         Shared data models & session format
packages/companion-client  Mobile ↔ desktop networking
packages/protocol       Wire protocol between devices
packages/sdk            Client SDK
```

The agent engine runs locally in the desktop app — your code never leaves your machine except for the API calls to the model provider you choose.

---

## 🛣️ Roadmap

### v0.1 — *released*
- Desktop app (Electron) + mobile companion (Expo)
- Plan / Build / Orchestrate modes, subagents, skills, permissions
- MCP support, terminal, browser, git integration
- Persistent memory graph

### v0.2
- **Conveyor mode** — a task pipeline (esteira): boards with phases (plan → develop → validate → done), manual or automatic execution, per-phase prompts and models
- **Routines** — scheduled, recurring agent tasks
- Team collaboration & shared memories

### v0.3
- Cloud sync & remote execution (**Fragments Plus**)
- Fragments ecosystem integration (Nodara, Fracta, …)
- Agent marketplace

### Future
- **System-wide quick access** — instant Orbit from anywhere: quick chat, translate selected text, and ask the agent to look at your desktop to help with something
- **Speech-to-text & text-to-speech** — talk to Orbit and have it talk back
- **Computer use** — the agent operates your desktop directly
- **Natural chat** — the agent reaches out on its own (no message needed), replies in short messages instead of one long block, and can take its time — simulating a real conversation that follows your writing style

---

## 🤝 Contributing

Orbit is **free software** under the [GNU GPLv3](./LICENSE) (plus an [additional permission for app stores](./LICENSE-EXCEPTION)) and welcomes contributions — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the terms that apply to pull requests.

1. **Fork** the repo and create a branch from `homolog` (the active development line)
2. Follow the existing code style — this is a TypeScript monorepo with strict typechecking and lint
3. **Commit convention**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat(desktop): ...`, `fix(mobile): ...`, `docs: ...`, etc.
4. Open a **pull request against `homolog`** — `master` receives merges only when a release phase is closed

Before submitting:

```bash
npm run typecheck   # must pass
npm test            # must pass
npm run lint        # must pass with zero warnings
```

Tests run with [Vitest](https://vitest.dev) and live next to the code they
cover (`*.test.ts`). The suite targets the pure logic where a regression is
silent and expensive — provider error classification, model-rotation
resolution, context compaction, the unified-diff parser and the engine's turn
annotations. Anything needing Electron, the network or a model isn't covered:
keep those boundaries behind a mockable module, as `model-rotation.ts` does.

Keep changes surgical and focused — review is easier when each PR does one thing.

---

## ❤️ Support

If Orbit helps you build, consider supporting Fragments Labs — every coffee fuels the project:

**[ko-fi.com/fragmentslabs](https://ko-fi.com/fragmentslabs)**

---

## 📄 Licensing

Orbit is **free software**, licensed under the **GNU General Public License v3** (or any later version). You can use, modify and redistribute it — including commercially — as long as anything you distribute that is based on it stays free software under the same license.

**One additional permission:** you may also distribute Orbit, or a modified version of it, through app stores — Apple App Store, Mac App Store, Google Play, Microsoft Store — even though those stores impose terms the GPL would otherwise forbid. The condition doesn't change: the source has to stay available under the GPL. See [LICENSE-EXCEPTION](./LICENSE-EXCEPTION).

| ✅ You can | ⚠️ You must |
|---|---|
| Use it personally, at work, or in a company of any size | Keep [LICENSE](./LICENSE), [LICENSE-EXCEPTION](./LICENSE-EXCEPTION) and [NOTICE](./NOTICE) with any copy you distribute |
| Read, modify, audit and fork the source | Publish the source of your modified version under the GPL |
| Distribute it through app stores (that's the extra permission) | State that you changed the files, if you did |
| Rename it and ship your own version | Not imply that Fragments Labs endorses your fork |
| Sell it, host it, or build a product on top of it | — |

**The app is free software. The parts that cost money to run are a paid service.** The core app is free and ad-supported; **Fragments Plus** (cloud memory, mobile access from anywhere, the relay that connects desktop and mobile outside your local network, hosted model inference, and access to the rest of the Fragments suite — Nodara, Fracta, ...) is a paid subscription running on Fragments Labs' closed-source servers. Nothing that was ever free is locked behind it.

[Full license text](./LICENSE) · [Additional permission for app stores](./LICENSE-EXCEPTION)

Releases published before October 2026 were made available under the Business Source License 1.1 and remain available under those terms.

Orbit includes code derived from [opencode](https://github.com/sst/opencode) (MIT) — see [NOTICE](./NOTICE) for attribution and the full upstream license text.

Orbit and Fragments Labs are project names and trademarks of Fragments Labs. The GPL does not grant rights to use them: forks are welcome, but must stand on their own name.
