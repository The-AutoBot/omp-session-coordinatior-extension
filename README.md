# OMP session coordinator extension

Standalone native OMP client extension extracted from the session coordinator server. Source TypeScript is the entrypoint; no build artifact, server checkout, OMP patch, or npm publication is required. The package remains `private: true`; that prevents npm publication, not direct GitHub installation.

## Install, update and remove

Use the official OMP plugin manager and Git on each PC. The standalone OMP executable embeds Bun for plugin installation; end users do not need a separate Bun installation. Install trusted code only: extensions run inside OMP, not in a sandbox.

```sh
omp plugin install github:The-AutoBot/omp-session-coordinatior-extension#v0.1.0
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

Before connecting **each PC**, obtain an enabled per-PC enrollment from the operator of a compatible broker: its credential-free `/bus` endpoint, unique lower-case PC ID and PC-specific machine key. Arrange network/TLS access and broker-side role authorization with that operator. Downloading this public repository grants no access to any coordinator or other PC.

Provision the key through your private process-launch/secret mechanism, separately from Git download and outside the repository. Do not put secrets in install commands, URLs, shell history, tracked settings or logs. Set the process environment below before launching the OMP process that will use it; installation alone supplies none of these values.

After install or update, start a new OMP process or perform a **user-directed full restart/resume** of the intended session. `/reload` does not reload extension modules. Uninstall likewise does not unload code already running: fully exit/restart that process to stop using it. Do not automatically restart active users.

**Load exactly once.** Before enabling this plugin, remove or disable the equivalent legacy `-e`/settings/managed-bootstrap registration for the intended future process. Do not combine plugin discovery with another copy of this extension. Native path deduplication is not a guard against separately copied entrypoints. Leave already-running users untouched until their planned restart.

## Compatibility and proof limits

Development types are pinned to `@oh-my-pi/pi-coding-agent` 18.3.0; that is not a minimum-version or universal host-compatibility claim. The current standard CLI inspected for this release is OMP 18.12.5. The host must expose the public extension APIs used here. Automatic collab additionally requires official local collab APIs/registry and a compatible interactive root; RPC/headless and unsupported API contexts retain their activation constraints. `OMP_EXECUTABLE` must refer to the same real standard OMP executable as the host.

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
- `OMP_EXECUTABLE`: absolute real OMP executable for official `collab list/link --json` discovery. Shell scripts (`.cmd`/`.bat`) are rejected; Windows requires `.exe`/`.com`. No executable is installed or selected by this repository.

Do not supply portal credentials, registry secrets, VAPID keys, or server configuration to the extension. Room links are capabilities: do not log or commit them. Broker authentication, per-PC identity, role authorization and opt-in steering remain enforced. Native input receipts read persisted host input; native voice commands are accepted only through the authenticated bus binding. Invalid/missing configuration leaves the extension unconnected rather than guessing a broker or identity.

## Ownership and integration

`src/extension/` owns the extension and real session-bus client. `src/shared/{protocol,machine-auth,machines,collab-input-receipts}.ts` are local copies of wire contracts; the server retains independent copies. Coordinate future wire changes across both repositories without runtime cross-checkout imports or shims.

Public package exports are the root default extension plus `resolveSessionDisplayName`, and `./session-bus-client`, `./collab-registry`, `./native-input-receipt`, `./native-voice`. Server development tests may depend on a pinned Git commit of this package. Production server dependency installation must exclude that development dependency.

Moved tests: `extension-collab-lifecycle.integration.test.ts`, `native-input-receipt.test.ts`, `session-name.test.ts`. Broker/portal/reliability integration fixtures stay in the server repository and migrate their client imports to package exports. No server implementation, user guidance files, secrets, logs, temporary files or node_modules were copied into this repository.

## Release and licensing

The initial package version is `0.1.0`, intended for Git tag `v0.1.0`; release tagging/publication is separate from editing this package. No npm publishing workflow is required. This repository currently declares no license grant; public visibility and installability alone do not grant general redistribution or modification rights.
