# OMP session coordinator extension

Standalone native OMP client extension extracted from the session coordinator server. Source TypeScript is the entrypoint; no build artifact, server checkout, OMP patch, or npm publication is required. The package remains `private: true`; that prevents npm publication, not direct GitHub installation.

## Install, update and remove

Use the official OMP plugin manager and Git on each PC. The standalone OMP executable embeds Bun for plugin installation; end users do not need a separate Bun installation. Install trusted code only: extensions run inside OMP, not in a sandbox.

```sh
omp plugin install github:The-AutoBot/omp-session-coordinatior-extension#v0.2.1
omp plugin list
```

The manifest registers `./src/extension/index.ts` automatically for enabled plugin discovery in new OMP processes. Installation downloads code and dependencies and validates the extension import/factory; it does **not** enroll a PC, provision credentials, deploy the broker, grant coordinator permissions, or prove a broker connection. Native syntax was confirmed against standard OMP 18.12.5 help and the [official installer lifecycle](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md).

```sh
omp plugin upgrade @autobot/omp-session-coordinator-extension
omp plugin uninstall @autobot/omp-session-coordinator-extension
```

`upgrade` re-resolves the recorded Git ref, so a fixed release tag stays pinned. To select a newer release, install its explicit `github:The-AutoBot/omp-session-coordinatior-extension#<new-tag>` spec instead. There is no automatic startup update. Uninstall removes plugin registration/package state, not broker enrollment or separately provisioned secrets; ask the broker administrator to revoke the PC key when decommissioning a PC.

Git/npm plugin operations are user-scoped; `--scope project` does not isolate them. For disposable qualification use a dedicated named OMP `--profile` with owned configuration, not a live user profile. Never change installed OMP/SDK, PATH or active sessions to install this extension.

## Enrollment and activation

On a new PC, install the pinned release above, then start a new OMP process and run:

```text
/session-connect https://agent.theautobot.ca
```

No bus environment credentials are needed on the new PC. The command displays a verification link and short code and offers to open your standard browser; choose No to use the link/code manually. Headless contexts never open the browser. Sign in to `https://agent.theautobot.ca` with your authorized dashboard account and explicitly approve/name the new PC. Return to OMP and wait for the connected confirmation. The browser never receives the machine key. Installation alone grants no coordinator access. This enrollment command requires `v0.2.0` or later; `v0.1.0` does not include it.

Run `/session-connect` again at any time, including when already connected, to recover using the saved dashboard origin; supply a different HTTPS origin to change targets. `/session-connect cancel` cancels pending pairing. Only one pairing runs at a time; expiry, denial, cancellation, malformed responses, failed registration and failed credential persistence leave existing credentials and the active connection intact. Pairing first validates a separate temporary bus registration before committing the replacement. Re-pairing creates a new PC identity; previous credentials remain valid until explicitly revoked in the authenticated dashboard. Desktop access is not installed or enabled.

Credentials are atomically saved outside the repository and OMP profile: Windows `%LOCALAPPDATA%\omp-session-coordinator\device.json`, or POSIX `${XDG_CONFIG_HOME:-~/.config}/omp-session-coordinator/device.json`. Windows applies a protected current-user/SYSTEM directory ACL; POSIX uses a private directory and owner-only file. Permission setup failure aborts replacement. Do not copy or publish this file.

Explicit bus environment configuration remains authoritative by default, including partial/invalid configuration (no silent fallback). For recovery from environment-based configuration, `/session-connect` asks for explicit confirmation before switching to private local enrollment after successful validation and persistence. That durable user selection overrides the three bus credential environment variables; it does not modify environment files. Role/name/steering settings remain process-controlled. Without device enrollment support, an operator can still provision the per-PC ID, key and `/bus` endpoint through a private process-launch/secret mechanism. Never put keys in URLs, shell history, tracked settings or logs.

After install or update, start a new OMP process or perform a **user-directed full restart/resume** of the intended session. `/reload` does not reload extension modules. Uninstall likewise does not unload code already running: fully exit/restart that process to stop using it. Do not automatically restart active users.

**Load exactly once.** Before enabling this plugin, remove or disable the equivalent legacy `-e`/settings/managed-bootstrap registration for the intended future process. Do not combine plugin discovery with another copy of this extension. Native path deduplication is not a guard against separately copied entrypoints. Leave already-running users untouched until their planned restart.

## Compatibility and proof limits

Development types are pinned to `@oh-my-pi/pi-coding-agent` 18.3.0; that is not a minimum-version or universal host-compatibility claim. The current standard CLI inspected for this release is OMP 18.12.5. The host must expose the public extension APIs used here. Automatic collab additionally requires official local collab APIs/registry and a compatible interactive root; RPC/headless and unsupported API contexts retain their activation constraints. Standard compiled native OMP automatically uses its own executable for registry discovery; no manual `OMP_EXECUTABLE` setup is needed. Nonstandard runners require an explicit real native executable override.

CLI help and installer validation are not runtime/broker proof. The repository smoke below uses a protocol peer, not the actual broker. Native installed-host loading and disposable actual-broker qualification are separate release acceptance evidence; no claim here establishes activation in existing user sessions or production end-to-end operation.

## Development verification

From this repository:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run smoke
```

The lock preserves upstream resolved dependency versions and was regenerated for this package's dependency closure. No credentials are required for tests. `smoke` disables automatic .env loading, imports the package's public exports, and exercises the real client against an authenticated loopback WebSocket peer using the shared broker wire schemas (registration and correlated list response). It is not an actual broker implementation or full OMP host activation test. Server-owned integration tests consume this package separately and retain actual broker coverage.

For checkout independence, archive the committed repository into a fresh disposable directory outside both original checkouts, then run these same four commands there. Do not copy node_modules.

## Explicit checkout registration (development alternative)

After installing checkout dependencies, a compatible host can load the absolute entrypoint directly:

```sh
omp -e /absolute/path/to/omp-session-coordinatior-extension/src/extension/index.ts
```

On Windows use the real absolute Windows checkout path. This is an alternative to plugin discovery, not an additional registration. It does not modify installed settings or replace OMP.

## Process environment

Provision secrets separately; never commit an environment file. Configure only the child process that will load the extension:

- `OMP_SESSION_BUS_ENDPOINT`: explicit credential-free `wss:` endpoint ending in `/bus`; `ws:` is restricted to loopback development. No embedded credentials, query, or fragment.
- `OMP_SESSION_BUS_PC_ID`: enrolled lower-case PC identifier, 1–63 characters (`[a-z0-9][a-z0-9-]*`).
- `OMP_SESSION_BUS_MACHINE_KEY`: PC-specific secret, 32–512 UTF-8 bytes, no whitespace/control characters; transmitted via authenticated machine handshake headers, not URL parameters.
- `OMP_SESSION_BUS_ROLE`: `participant` (default) or `coordinator`; broker authorization determines actual coordinator authority.
- `OMP_SESSION_BUS_NAME`: optional bounded display-name override; existing session name/default behavior otherwise applies.
- `OMP_SESSION_BUS_ALLOW_STEER=1`: explicit local opt-in to steering; default off. Broker permissions still apply.
- `OMP_SESSION_AUTO_COLLAB=0`: disables automatic local collab discovery/publication; enabled otherwise where host/context support it.
- `OMP_EXECUTABLE`: optional absolute real OMP executable override for official `collab list/link --json` discovery. When absent or empty, standard compiled native OMP uses its own running executable; development Bun/Node runners fail closed. Nonempty overrides remain authoritative and must point to the same native OMP as the host. Shell scripts (`.cmd`/`.bat`) are rejected; Windows requires `.exe`/`.com`. No executable is installed by this repository.

Do not supply portal credentials, registry secrets, VAPID keys, or server configuration to the extension. Room links are capabilities: do not log or commit them. Broker authentication, per-PC identity, role authorization and opt-in steering remain enforced. Native input receipts read persisted host input; native voice commands are accepted only through the authenticated bus binding. Invalid/missing configuration leaves the extension unconnected rather than guessing a broker or identity.

## Ownership and integration

`src/extension/` owns the extension and real session-bus client. `src/shared/{protocol,machine-auth,machines,collab-input-receipts}.ts` are local copies of wire contracts; the server retains independent copies. Coordinate future wire changes across both repositories without runtime cross-checkout imports or shims.

Public package exports are the root default extension plus `resolveSessionDisplayName`, and `./session-bus-client`, `./collab-registry`, `./native-input-receipt`, `./native-voice`. Server development tests may depend on a pinned Git commit of this package. Production server dependency installation must exclude that development dependency.

Moved tests: `extension-collab-lifecycle.integration.test.ts`, `native-input-receipt.test.ts`, `session-name.test.ts`. Broker/portal/reliability integration fixtures stay in the server repository and migrate their client imports to package exports. No server implementation, user guidance files, secrets, logs, temporary files or node_modules were copied into this repository.

## Release and licensing

Release `0.2.1` is installed using the immutable Git tag `v0.2.1` shown above. It retains browser-approved per-PC enrollment from `0.2.0` and fixes native registry discovery on a fresh PC without manual executable configuration. No npm publishing workflow is required. This repository currently declares no license grant; public visibility and installability alone do not grant general redistribution or modification rights.
