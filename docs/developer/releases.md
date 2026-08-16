# Releases

Release process, version management, and the auto-update system.

## Overview

Two workflows in `.github/workflows/`:

- **`ci.yml`** — runs on every pull request and every push to `main`. Frontend
  checks and Rust checks always; a three-platform bundle only off pull requests,
  because the bundler is the part that breaks per-platform and a tag is a bad
  place to find that out.
- **`release.yml`** — runs on a `v*` tag. A preflight job settles everything
  knowable from one Linux box (version agreement, `check:all`) before three
  runners start bundling. Produces a **draft** GitHub release.

Releases are cross-platform (macOS universal, Windows, Linux) and carry a signed
`latest.json` that installed copies read to discover updates.

## One-time setup

### Updater signing key

Updates are verified against a public key compiled into the app. The keypair is
generated once and must never change afterwards — installed copies only trust
the key they shipped with.

```bash
npm run tauri signer generate -- -w ~/.tauri/ideo.key
```

The public half is already in `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. The private half stays out of the repository.

### GitHub repository secrets

Settings → Secrets and variables → Actions:

| Secret                               | What it is                                             |
| ------------------------------------ | ------------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of `~/.tauri/ideo.key`                        |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password; set to empty if the key has none         |
| `APPLE_CERTIFICATE`                  | Base64 of the exported Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD`         | Password set when exporting that `.p12`                |
| `APPLE_ID`                           | Apple ID email                                         |
| `APPLE_PASSWORD`                     | App-specific password, **not** the Apple ID password   |
| `APPLE_TEAM_ID`                      | Team ID (`NBUP88JQ35`)                                 |

Note the v2 names: `TAURI_SIGNING_PRIVATE_KEY`, not the v1 `TAURI_PRIVATE_KEY`.

The certificate must be a **Developer ID Application** identity. An Apple
Development certificate builds fine, then fails notarization, and Gatekeeper
rejects the result — so the workflow checks for the right one and fails loudly.

## Release process

```bash
npm run release:prepare v1.0.0
```

Which will:

1. Refuse to continue on a dirty working tree
2. Run `npm run check:all`
3. Set the version in `package.json`, `Cargo.toml` and `tauri.conf.json`
4. Offer to commit, tag and push

Then, on the tag, GitHub Actions:

1. Verifies the tag matches all three manifests, and re-runs the checks
2. Builds and signs for all three platforms
3. Notarizes the macOS build
4. Creates a **draft** release with the installers, signatures and `latest.json`

Finally, **publish the draft release on GitHub**. Until you do, the updater
endpoint (`releases/latest/download/latest.json`) does not resolve, so no
installed copy will see the update.

### Manual method

```bash
npm run check:all
# set the version in package.json, Cargo.toml and tauri.conf.json
git commit -am "chore: release v1.0.0"
git tag v1.0.0
git push origin main --tags
```

## Version strategy

Semantic versioning. All three files must agree, and the preflight job fails the
release if they don't:

- `package.json` → `"version": "1.0.0"`
- `src-tauri/Cargo.toml` → `version = "1.0.0"`
- `src-tauri/tauri.conf.json` → `"version": "1.0.0"`

## Auto-update system

Implemented in [`src/lib/updater.ts`](../../src/lib/updater.ts).

- **At launch**: one check, five seconds in, silent. Nothing is shown unless an
  update exists — someone who opened the app to do something else should not be
  told that nothing has changed.
- **On demand**: the App → Check for Updates menu item, or "Check for Updates"
  in the command palette. This route reports every outcome, including "you're on
  the latest version", because silence would read as a broken button.

An available update appears as a toast with an Install action. Download progress
replaces that toast in place, and a Restart action appears when it completes.

Update artifacts exist for macOS (`.app.tar.gz`), Windows (`.msi.zip`) and Linux
(AppImage only — `.deb` installs are not self-updating).

### The macOS target key

macOS ships one universal binary, which the bundler files in `latest.json` under
`darwin-universal`. The updater's default lookup key is `darwin-aarch64` or
`darwin-x86_64`, so `lib.rs` overrides it to `darwin-universal` on macOS.

These two have to agree. If the release ever stops being universal, or the
override is dropped, macOS finds no matching key and reports being up to date
forever — the failure is silent, which is what makes it worth stating here.

## Local builds

`createUpdaterArtifacts` is on, so the bundler signs its output and
`npm run tauri:build` needs the signing key:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ideo.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

`bundle.macOS.signingIdentity` stays `"-"` (ad-hoc) so local builds work without
a certificate. CI overrides it via `APPLE_SIGNING_IDENTITY`.

## Troubleshooting

| Issue                              | Cause                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Workflow doesn't trigger           | Tag must start with `v` and be pushed (`git push --tags`)                   |
| Preflight fails on versions        | The three manifests disagree with the tag; `release:prepare` sets all three |
| Bundler fails on a missing key     | `TAURI_SIGNING_PRIVATE_KEY` not set — required by `createUpdaterArtifacts`  |
| "No Developer ID Application"      | `APPLE_CERTIFICATE` holds a development cert, not a distribution one        |
| Notarization fails to authenticate | `APPLE_PASSWORD` must be an app-specific password, and `APPLE_TEAM_ID` set  |
| Updates never detected             | The release is still a draft, so `releases/latest` doesn't resolve          |
| Update rejected after download     | Built with a different signing key than the `pubkey` in `tauri.conf.json`   |
