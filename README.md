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

*Capabilities evolve fast — this table reflects v0.1.0; verify before choosing a tool.*

---

## ✨ Features (v0.1.0)

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

**Requirements:** Node.js 20+, npm.

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

Orbit is **source-available** under the [Business Source License 1.1](./LICENSE) and welcomes contributions. By opening a pull request you agree that your contribution is licensed to Fragments Labs under the project's license terms, so the project can maintain its licensing model.

1. **Fork** the repo and create a branch from `homolog` (the active development line)
2. Follow the existing code style — this is a TypeScript monorepo with strict typechecking and lint
3. **Commit convention**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat(desktop): ...`, `fix(mobile): ...`, `docs: ...`, etc.
4. Open a **pull request against `homolog`** — `master` receives merges only when a release phase is closed

Before submitting:

```bash
npm run typecheck   # must pass
npm run lint        # must pass with zero warnings
```

Keep changes surgical and focused — review is easier when each PR does one thing.

---

## ❤️ Support

If Orbit helps you build, consider supporting Fragments Labs — every coffee fuels the project:

**[ko-fi.com/fragmentslabs](https://ko-fi.com/fragmentslabs)**

---

## 📄 Licensing

Orbit uses the **Business Source License 1.1**.

| ✅ Allowed | ❌ Not allowed |
|---|---|
| Personal use | Competing hosted services |
| Internal company use (within the Additional Use Grant) | Removing monetization features (ads, subscription) |
| Reading, modifying and auditing the source | Redistributing commercial forks |
| Running the app with your own models and providers | Using it beyond the grant without a commercial license |

After **four years**, each release automatically converts to **Apache-2.0**.

[Full license text](./LICENSE) · commercial licenses: [ko-fi.com/fragmentslabs](https://ko-fi.com/fragmentslabs)

The core app is free with ads; **Fragments Plus** (cloud memory, mobile anywhere, and access to the Fragments app suite — Nodara, Fracta, ...) is a paid subscription powered by Fragments Labs' closed-source servers, in the spirit of n8n and Supabase.

Orbit includes code derived from [opencode](https://github.com/sst/opencode) (MIT) — see [NOTICE](./NOTICE) for attribution and the full upstream license text.
