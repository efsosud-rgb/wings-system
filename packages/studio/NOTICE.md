# Wings Studio core — provenance and changes

This package is a fork of the **Shotstack Studio SDK**, taken from
<https://github.com/shotstack/shotstack-studio-sdk> at tag/npm version
**2.19.6** (commit `7c5c213`, 2026-09-16). It is licensed under the
**PolyForm Shield License 1.0.0** (see `LICENSE`), whose required notice is:

> Required Notice: Copyright Shotstack Pty Ltd (https://shotstack.io)

The licence allows use, modification and distribution for any purpose except
providing a product that competes with Shotstack. Wings Studio is an internal
tool of Wings Company; it is not offered to third parties. Read `LICENSE`
before changing that.

`UPSTREAM-README.md` and `UPSTREAM-CHANGELOG.md` are the SDK's own files at
that version, kept for reference; they describe the SDK, not this package.

## What was removed

- `src/main.ts` and `src/templates/` (demo app and demo templates that point at
  Shotstack's asset buckets).
- Jest, ESLint (Airbnb), Husky, semantic-release configuration. Tests run under
  Vitest through `tests/setup.ts`.

## What was changed

Every change is small and local, so upstream fixes can still be brought over:

| File                                                   | Change                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/wings.ts` (new)                                   | `configureStudio()` — where the app tells the core which URLs serve HarfBuzz and resvg WASM, and the theme to use                            |
| `src/components/canvas/players/svg-player.ts`          | `initResvg()` reads the configured WASM URL instead of unpkg.com                                                                             |
| `src/components/canvas/players/rich-caption-player.ts` | `FontRegistry.getSharedInstance()` reads the configured WASM URL instead of js.shotstack.io                                                  |
| `src/core/fonts/font-config.ts`                        | The eleven built-in fonts resolve through the Google Fonts list instead of templates.shotstack.io; two proprietary ones fall back to Roboto  |
| `src/core/export/export-coordinator.ts`                | New `render()` that returns the MP4 as a `Blob` with a chosen bitrate and a progress callback; `export()` now downloads what `render()` made |
| `src/core/theme/theme.resolver.ts`                     | Default timeline colours are the Wings palette                                                                                               |
| `src/index.ts`                                         | Exports `configureStudio`, `UPSTREAM_VERSION`; `VERSION` is this package's                                                                   |

Network access that remains, by design: Google Fonts (`fonts.gstatic.com`) for
the font picker, and whatever URLs the host app puts in the edit (Drive links).
Nothing in this package calls a Shotstack service.

## Bringing upstream changes

```bash
git clone --branch v<version> https://github.com/shotstack/shotstack-studio-sdk /tmp/sdk
diff -ru /tmp/sdk/src packages/studio/src | less
```

Apply what matters, update the version and commit at the top of this file.
