# orbit-fragments-api

Typed declarations for the `window.orbit` API that Orbit fragments run against.

```bash
npm install --save-dev orbit-fragments-api
```

```js
// @ts-check
/// <reference types="orbit-fragments-api" />

const saved = await orbit.store.get('notes')
orbit.on('theme', (theme) => document.body.dataset.theme = theme)
```

The package has no runtime role inside a fragment: the app injects `window.orbit` itself. It exports
`ORBIT_SDK_VERSION` (the bridge protocol major, the `sdk` field of `manifest.json`) and
`isCompatibleSdk(sdk)` for tooling that wants to check a manifest.

Use `orbit-fragments` to scaffold, validate and pack a fragment.
