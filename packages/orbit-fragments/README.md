# orbit-fragments

Scaffold and validate Orbit fragments from the terminal.

```bash
npx orbit-fragments init my-notes --kind panel
npx orbit-fragments validate my-notes
```

- `init <dir> [--name <name>] [--kind screen|panel|widget]` creates a small working fragment: `manifest.json`, `src/index.html`, a script that uses `orbit.store`, styles, and a `jsconfig.json` that types `orbit` through `orbit-fragments-api`.
- `validate [dir] [--json]` checks `manifest.json` and `src/` against the rules Orbit enforces (the same code the app runs): manifest fields, `sdk` compatibility, capabilities, allowed file types, sizes, file count and the `index.html` entry. Exit code 1 when there are errors; warnings (remote URLs, unknown fields, hidden files) do not fail.
