# Contributing to Orbit

Thanks for wanting to help. Orbit is free software — GPLv3 with an additional
permission for app stores. See [LICENSE](./LICENSE) and
[LICENSE-EXCEPTION](./LICENSE-EXCEPTION). Contributions are welcome from anyone.

## Workflow

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

Tests run with [Vitest](https://vitest.dev) and live next to the code they cover
(`*.test.ts`). The suite targets the pure logic where a regression is silent and
expensive — provider error classification, model-rotation resolution, context
compaction, the unified-diff parser and the engine's turn annotations. Anything
needing Electron, the network or a model isn't covered: keep those boundaries
behind a mockable module, as `model-rotation.ts` does.

Keep changes surgical and focused — review is easier when each PR does one thing.

## Contribution terms

By opening a pull request, you confirm that:

1. **You wrote the contribution**, or you otherwise have the right to submit it.
   If you are contributing work you made for an employer, you have permission
   to do so.
2. **You license your contribution to Fragments Labs under the project's terms**
   — the GPLv3 together with the additional permission in
   [LICENSE-EXCEPTION](./LICENSE-EXCEPTION).
3. **You also grant Fragments Labs a perpetual, worldwide, royalty-free and
   irrevocable license to use, reproduce, modify and distribute your
   contribution under other license terms.** This keeps the project able to
   distribute official builds through the app stores, and able to adjust its
   licensing later without having to ask every past contributor for permission.

You keep the copyright of your contribution. This is **not** a copyright
assignment, it does not take your name off your work, and it does not stop you
from using your own code however you like.

If you are not comfortable with point 3, open an issue describing the change
instead — we can work something out, or you can keep your fork.
