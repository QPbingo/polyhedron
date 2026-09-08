# macOS host operations

Run commands from `backend/`. Node 22.13+ and the user's native Codex/Claude installation are required. No script has been installed globally or used to sign/notarize an artifact during implementation.

## Diagnose and configure

`npm run diagnose` runs bounded native `--version` and `--help` probes. `POLY_CODEX_PATH` and `POLY_CLAUDE_PATH` select absolute executable paths explicitly; an invalid override fails instead of picking another install. Both PTYs run with the project directory as cwd. Use the backend's pairing/configuration workflow before installing services.

On macOS production config should reference `hostTokenKeychain: { "service": "com.polyhedron.host", "account": "<host-id>" }`. `src/adapters/keychain.ts` exports `readHostToken`, `storeHostToken`, and `deleteHostToken` (service, account; store also takes token). Store uses `/usr/bin/security -i` with stdin, never a token argument or shell; helper errors do not echo secrets. Native Keychain access may require user consent/unlocking. Input-validation tests run without modifying the Keychain; real Keychain read/write remains a release acceptance check. Development may explicitly use a mode-0600 credential file. Do not copy development credentials into packages.

## Generate, inspect, install, uninstall

```sh
npm run build
node scripts/launchagent.mjs generate --config /absolute/path/host.json
plutil -lint .data/launchagents/*.plist
# Explicitly install only after reviewing generated jobs/config:
node scripts/launchagent.mjs install --config /absolute/path/host.json
# Explicit removal stops host-owned PTYs but keeps data and credentials:
node scripts/launchagent.mjs uninstall
```

`generate` only writes two private plist artifacts. `install` creates per-user `~/Library/LaunchAgents/com.polyhedron.{host,connector}.plist` and bootstraps both with `launchctl`; never use sudo. No existing jobs are overwritten. Each job restarts independently; restarting the connector does not intentionally stop the host. Host restart cannot preserve live PTYs. The relay is a separate service and is not installed here. Logs are in the config directory's private `logs/`; rotate them operationally. Set `--backend`, `--node`, `--output` for explicit paths. CLI PATH includes Homebrew and `~/.local/bin` because launchd does not read shell startup files.

A generated job points at the current installation location. Move/rebuild it before install if this repository is temporary. The host should be paired and configured before service start. If bootstrap fails after copying a plist, inspect `launchctl print gui/$(id -u)/com.polyhedron.host`, resolve the cause, and explicitly remove/reinstall the affected job.

## Package and release

```sh
# Download the official portable Node 24 runtime; optional --version pins a specific v24.x.y.
node scripts/download-node.mjs --arch arm64 --output /absolute/new/node24
# Retain staging only when preparing a release; choose a new absolute directory.
NODE_BINARY=/absolute/new/node24/bin/node \
PACKAGE_STAGE_DIR=/absolute/new/staging scripts/build-macos-package.sh
# Actual credentials are required for this separate explicit release action:
SIGNING_IDENTITY='Developer ID Application: Your Org (TEAM)' \
PKG_SIGNING_IDENTITY='Developer ID Installer: Your Org (TEAM)' \
NOTARY_PROFILE='existing-notarytool-profile' \
PACKAGE_ROOT=/absolute/new/staging/root \
SIGNED_PACKAGE=/absolute/output/PolyhedronHost.pkg \
scripts/sign-notarize-macos.sh
```

The unsigned package requires an explicit portable `NODE_BINARY` and rejects non-system dynamic library dependencies using `otool -L` before building. Homebrew Node is deliberately rejected: copying it alone does not bundle its libuv/OpenSSL/ICU dependencies. The download helper fetches only HTTPS `nodejs.org/dist` URLs without redirects, resolves the latest Node 24 alias to a pinned release, compares the archive SHA-256 against that release’s `SHASUMS256.txt`, validates archive paths, and saves provenance in `polyhedron-download.json`. This checks transport and artifact integrity; it does not claim independent verification of a release signing key. Use `--arch x64` on an Intel build host.

The unsigned package bundles that portable Node binary, compiled backend, scripts, and installed node_modules under `/usr/local/lib/polyhedron-host`. It contains no host config, CLI login, pairing token, launch-agent registration, postinstall job, or relay deployment. Build separately on each target architecture; native node-pty binaries and Node must match. The signing script signs Mach-O payloads, signs the installer, submits to Apple's notary service with a previously stored profile, staples, and verifies. A Node runtime signing policy/entitlements appropriate to its V8 JIT may be required; validate the signed Node and PTY spawn on a clean target Mac before release. This scaffold is not evidence of a signed, notarized, or clean-machine-validated release.


After installing a package, use its bundled Node to configure per-user services; this does not require a Homebrew Node installation:

```sh
/usr/local/lib/polyhedron-host/bin/node \
/usr/local/lib/polyhedron-host/scripts/launchagent.mjs generate \
--config /absolute/path/host.json
```

Review generated plists, then invoke the same command with `install` explicitly. The generated default Node path is the portable executable running the helper. The native vendor CLIs remain separately installed and authenticated by the user.
