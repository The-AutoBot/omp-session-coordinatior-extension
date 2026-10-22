# OMP session coordinator extension

Standalone OMP client extension extracted from the session coordinator server. Requires Bun and a compatible OMP host; development types are pinned to `@oh-my-pi/pi-coding-agent` 18.3.0. No server checkout, installed runtime patch, global install, or package registry publication is required. Source TypeScript is the entrypoint; no build artifact is needed.

## Install and verify

From this repository:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run smoke
```

The lock preserves upstream resolved dependency versions and was regenerated for this package's dependency closure. No credentials are required for tests. `smoke` disables automatic .env loading, imports the package's public exports, and exercises the real client against an authenticated loopback WebSocket peer using the shared broker wire schemas (registration and correlated list response). It is not an actual broker implementation or full OMP host activation test. Server-owned integration tests consume this package separately and retain actual broker coverage.

For checkout independence, archive the committed repository into a fresh disposable directory outside both original checkouts, then run these same four commands there. Do not copy node_modules.

## Explicit registration

After installing repository dependencies, launch a new compatible OMP process with the absolute extension entrypoint:

```sh
omp -e D:/Projects/omp-session-coordinatior-extension/src/extension/index.ts
```

This is an invocation example, not an instruction to modify installed settings. Use the real checkout path on other machines. Do not load this extension twice: managed OMP installations may already include a session-bus extension. Registration does not install or replace OMP, modify PATH, edit user configuration, deploy a broker, or restart an active session. The host must support the public APIs used here; automatic collab requires official local collab APIs/registry and a compatible interactive root. RPC/headless and unsupported API contexts retain their existing activation constraints.

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
