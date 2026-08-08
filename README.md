# Ideo

A macOS app for making **landing-page hero visuals** — images and short looping
video. No text, no copy, just the visual.

## What it does

Three steps, each one a call to an image or video model:

1. **Source** — write a prompt to generate an image, or upload one you already have.
2. **Style** — apply a look from a library of style presets: film grain, duotone,
   risograph, iridescent, glass caustics, and so on. Presets are prompt recipes, so
   the styling is generated rather than filtered.
3. **Animate** — turn the still into a few seconds of subtle, seamless, looping
   motion. Optional; plenty of heroes are just a still.

Then export web-ready files — MP4, WebM, and a poster frame at sizes you can
actually ship on a page.

## How it works

Everything runs locally. There is no server, no backend, and no shared state.

Each person supplies their own [fal.ai](https://fal.ai) API key, stored in their own
macOS Keychain, so generation is billed to their own account. The key never leaves
the Rust side of the app.

Projects are saved as folders on disk containing the generated assets plus a
manifest of the full recipe — prompt, style preset, model, parameters, seed. That
means a hero you made last month can be reopened and re-run with one thing changed,
instead of being rediscovered from scratch.

Which controls appear depends on the model you pick. The app keeps a registry of
what each model supports — aspect ratios, seeds, end-frame conditioning for looping
— and shows only what that model can actually do.

## Status

**Not built yet.** The design is settled and written up; implementation hasn't
started.

- [`docs/prd/ideo-prd.md`](docs/prd/ideo-prd.md) — the umbrella spec, including the
  open questions and what's still unverified
- [`docs/tasks-todo/`](docs/tasks-todo/) — work items, lowest number first
- [`docs/research/`](docs/research/) — raw research notes on models and prompt
  recipes, with per-claim verification markers

## Development

Requires Node 20+, Rust, and Xcode command line tools.

```bash
npm install
npm run tauri:dev     # run the app
npm run check:all     # typecheck, lint, format, clippy, tests
```

`ffmpeg` is needed for video export: `brew install ffmpeg`.

See [`AGENTS.md`](AGENTS.md) for architecture patterns and
[`docs/developer/`](docs/developer/) for detailed guides.

## License

Copyright (c) 2026 Michael Wilhelmsen. Licensed under the **GNU Affero General
Public License v3.0** — see [LICENSE](LICENSE). If you distribute or network-host
a modified version, you must make your source available under the same terms.

The application scaffold derives from
[dannysmith/tauri-template](https://github.com/dannysmith/tauri-template) (MIT).
See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
