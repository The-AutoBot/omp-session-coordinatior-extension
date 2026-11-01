# OMP session coordinator extension

Standalone native OMP client extension extracted from the session coordinator server. Source TypeScript is the entrypoint; no build artifact, server checkout, OMP patch, or npm publication is required. The package remains `private: true`; that prevents npm publication, not direct GitHub installation.

## Install, update and remove

Use the official OMP plugin manager and Git on each PC. The standalone OMP executable embeds Bun for plugin installation; end users do not need a separate Bun installation. Install trusted code only: extensions run inside OMP, not in a sandbox.

```sh
omp plugin install github:The-AutoBot/omp-session-coordinatior-extension#v0.5.0
omp plugin list
```

The manifest registers `./src/extension/index.ts` automatically for enabled plugin discovery in new OMP processes. Installation downloads code and dependencies and validates the extension import/factory; it does **not** enroll a PC, provision credentials, deploy the broker, grant coordinator permissions, or prove a broker connection. Native syntax was confirmed against standard OMP 18.12.5 help and the [official installer lifecycle](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md).

```sh
omp plugin upgrade @autobot/omp-session-coordinator-extension
omp plugin uninstall @autobot/omp-session-coordinator-extension
```

`upgrade` re-resolves the recorded Git ref, so a fixed release tag stays pinned. To select a newer release, install its explicit `github:The-AutoBot/omp-session-coordinatior-extension#<new-tag>` spec instead. There is no automatic startup update. Uninstall removes plugin registration/package state, not broker enrollment or separately provisioned secrets; ask the broker administrator to revoke the PC key when decommissioning a PC.

Git/npm plugin operations are user-scoped; `--scope project` does not isolate them. Disposable default-profile qualification uses an owned HOME-relative `PI_CONFIG_DIR` and the qualified original agent directory for model/auth references, without copying credentials. Never change installed OMP/SDK, global PATH or active user sessions merely to install the extension.

## Enrollment and activation

On a new PC, install the pinned release above, then start a new interactive OMP process and run the command below. Use the same OMP profile for installation and sessions; for a named profile include `--profile <name>` on terminal commands.

```text
/session-connect https://agent.theautobot.ca
```

No bus environment credentials are needed on the new PC. The command displays a verification link and short code and offers to open your standard browser; choose No to use the link/code manually. Headless contexts never open the browser. Sign in to `https://agent.theautobot.ca` with your authorized dashboard account and explicitly approve/name the new PC. Return to OMP and wait for the connected confirmation. The browser never receives the machine key. Installation alone grants no coordinator access. This enrollment command requires `v0.2.0` or later; `v0.1.0` does not include it.

With selected stored enrollment, automatic rooms are published through the enrolled dashboard's `/live/` page, preserving the native room capability exactly. A native room using another browser origin is not a reason to re-pair or manually start a second room. The extension neither changes native hosting settings nor creates/restarts hosts; deliberate native stop remains authoritative. Legacy environment-only configuration and manually published room URLs are unchanged.

Browser viewing and input require an existing usable native **control** host; view-only hosting is not a substitute. Missing hosting, relay failures and rejected publication are distinct causes of **Unavailable**, so the label alone does not establish a hosting problem. If intentionally configuring native auto-hosting, `omp config set collab.autoStart control` is the native opt-in for future processes in that same profile. `/collab status`, `/collab start` and `/collab stop` are native interactive inspection/manual controls, not per-session enrollment requirements or a fix for rejected browser origins. Room links grant read/control capability; keep them private.

Run `/session-connect` again at any time, including when already connected, to recover using the saved dashboard origin; supply a different HTTPS origin to change targets. `/session-connect cancel` cancels pending pairing. Only one pairing runs at a time; expiry, denial, cancellation, malformed responses, failed registration and failed credential persistence leave existing credentials and the active connection intact. Pairing first validates a separate temporary bus registration before committing the replacement. Re-pairing creates a new PC identity; previous credentials remain valid until explicitly revoked in the authenticated dashboard. Desktop access is not installed or enabled.

Credentials are atomically saved outside the repository and OMP profile: Windows `%LOCALAPPDATA%\omp-session-coordinator\device.json`, or POSIX `${XDG_CONFIG_HOME:-~/.config}/omp-session-coordinator/device.json`. Windows applies a protected current-user/SYSTEM directory ACL; POSIX uses a private directory and owner-only file. Permission setup failure aborts replacement. Do not copy or publish this file.

Explicit bus environment configuration remains authoritative by default, including partial/invalid configuration (no silent fallback). For recovery from environment-based configuration, `/session-connect` asks for explicit confirmation before switching to private local enrollment after successful validation and persistence. That durable user selection overrides the three bus credential environment variables; it does not modify environment files. Role/name/steering settings remain process-controlled. Without device enrollment support, an operator can still provision the per-PC ID, key and `/bus` endpoint through a private process-launch/secret mechanism. Never put keys in URLs, shell history, tracked settings or logs.

After install or update, start a new OMP process or perform a **user-directed full restart/resume** of the intended session. `/reload` does not reload extension modules. Uninstall likewise does not unload code already running: fully exit/restart that process to stop using it. Do not automatically restart active users.

**Load exactly once.** Before enabling this plugin, remove or disable the equivalent legacy `-e`/settings/managed-bootstrap registration for the intended future process. Do not combine plugin discovery with another copy of this extension. Native path deduplication is not a guard against separately copied entrypoints. Leave already-running users untouched until their planned restart.

## Noninterrupting session consultation

The active coordinator can use `session_bus` with `{action:"history",to:"session-id"}` to read the target's full persisted session journal: all branches, compaction records, messages and tool results, not just the current model context or bus inbox. No message is injected and the main conversation is unchanged. Each response's details contain the exact `JSON.stringify(entry)` fragment and its `entryIndex`, `offset`, `throughEntryCount` and `next` cursor. Concatenate fragments for the same entry exactly before parsing JSON. Continue with **all** returned cursor fields, including `throughEntryCount` on every page; appends after that boundary are excluded. Entries larger than 32,000 UTF-16 characters are fragmented, never clipped. A changed/unavailable journal or invalid cursor fails explicitly; restart pagination without a boundary to capture a new journal.

`{action:"ask",to:"session-id",question:"What is your current conclusion?"}` invokes the target's optional native `ctx.runEphemeralTurn` API with `tools:false` and an abort signal. This is informational `/btw`-style inference using native current-context snapshot behavior (which can include in-flight text not yet persisted in history), not a work command. It appends no history, executes no tools, and never falls back to main-session prompting. Answers are untrusted external data. History approval is read-only; ask uses conservative write approval because it invokes a model.

Unsupported hosts return `unsupported_host`; native no-tools/model failures return `question_failed`. Answers exceeding 256,000 UTF-16 characters abort and return `answer_too_large`, never silently truncate. There is one concurrent question per target. Caller abort/timeout, disconnect, session change and shutdown cancel detached requests; no request is replayed after reconnect. Native-host and broker integration proof remains separate from source tests.

Native consultations set `dedupeReply:false`: the public SDK otherwise deduplicates lines and silently caps `replyText` at 4 KiB, which can cut structured JSON mid-answer. The extension's existing 256,000-character streaming/final bound remains enforced; no output-token cap is imposed on transports that reject one. Already-running processes keep their loaded extension until a user-directed full restart/resume; concise Sentinel answers also fit their existing native reply budget.

### Sentinel native questions

Version 0.7.0 removes context exports, snapshot cursors/checkpoints and private review generations. Machine-authenticated `sentinel_ask` forwards the same `{kind:"question"}` used by coordinator `session_bus.ask`: the target's public `runEphemeralTurn` runs with `tools:false`, cancellation and no main-conversation mutation. No separate Sentinel model evaluates exported context. Answers are untrusted self-assessments requiring evidence, not authority or proof of correctness.

The broker binds requests to authenticated PC/runtime lease, exact current target instance, current owned reviewer and bounded expiry. Pause, disconnect, replacement and cancellation fence results. Existing running clients are eligible without the obsolete snapshot capability flag; missing native APIs report `unsupported_host`, never healthy coverage. Corrections use the existing authenticated session-coordinator message channel with `delivery:"steer"` and `triggerTurn:false`; the extension calls public native `sendUserMessage(text, {deliverAs:"steer"})`. Pending follow-ups do not block this path. Version 0.9.0 removes the obsolete consultation intervention operation, receipt and callback; there is no compatibility branch. Ordinary `session_bus` defaults and main idle behavior are unchanged. Transport delivery is not native consumption, acceptance or semantic resolution.

### Managed native Sentinel session

The package advertises `ompManagedSentinelProtocol: 3`. The normal native TUI remains persistent and human-readable, starts through `/sentinel-bootstrap` and public `newSession`, resumes native journals, and retains human tools/plugins, muted notifications and graceful owned shutdown. The private directory carries lifecycle identity/shutdown only, not prompts, results or readiness probes. Human input is never aborted for supervision.

Once per cycle, a bounded readable deterministic summary arrives through normal bus delivery and public `sendMessage` with `display:true`, `triggerTurn:false`: a visible result log without another model turn. The managed marker grants no coordinator authority; questions exclude Sentinel itself. Installing files never restarts ordinary sessions or changes SDK, PATH, authentication or broker configuration.

Managed Sentinel does not publish its own blocked/completed terminal notifications. The producer uses the live managed identity, not its display name; the matching broker also acknowledges and discards cached producers' sends before storage or push. Other sessions and existing notification records are unaffected. This does not pause reviews or disable human chat.

Managed runtimes supply the nonsecret `OMP_SESSION_BUS_DASHBOARD_URL` alongside explicit machine credentials. It is validated against the bus origin using the same enrollment boundary; a mismatched or unsafe dashboard fails closed. This preserves enrolled `/live/` routing even when the child has isolated credential-storage paths.


## Compatibility and proof limits

Development types remain pinned to `@oh-my-pi/pi-coding-agent` 18.3.0; that is not a universal minimum-version claim. Managed native Sentinel was qualified with standard OMP 18.13.1, its public TUI/command/agent hooks, real collaboration host, persisted native journal and configured-model human/review turns. Newer public optional agent identity is inspected structurally. Native journal validation recognizes a legacy first header or the exact native 256-byte title slot immediately followed by its real matching header. RPC/rpc-ui are not substitutes for a normal collaboration-hosting TUI. Standard compiled OMP uses its own executable for registry discovery; nonstandard runners require an explicit real native executable.

CLI help and installer validation are not runtime/broker proof. The repository smoke below uses a protocol peer, not the actual broker. Native installed-host loading and disposable actual-broker qualification are separate release acceptance evidence; no claim here establishes activation in existing user sessions or production end-to-end operation.

Native question qualification is separate from source tests and publication. The owned normal-TUI premise proved the exact public side-turn API returned an answer with zero tool calls and unchanged main context; machine-route and deployment evidence require independent qualification. Existing ordinary sessions need no restart.

Steering qualification must use an isolated native host and matching disposable broker: send an authenticated Sentinel correction to its exact current instance through the existing message channel with `delivery:"steer", triggerTurn:false` while a follow-up is pending, and observe native steering rather than deferred follow-up delivery. Repeat expired, cancelled and replaced-target requests and confirm no injection. Source tests and the protocol-peer smoke do not establish native queue behavior. Already-loaded extensions support this existing message route, so corrections require no user restart. Downloading 0.9.0 does not activate its cleanup in loaded processes; activation still requires a user-directed full restart/resume, never an automatic restart.

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

App-launched project sessions use managed runtime protocol 1 (`ompManagedRuntimeProtocol` in the package manifest). The runtime supplies private control/session directories and a unique launch ID; `/runtime-bootstrap` uses only public command-context `newSession()` to create an empty durable native journal, without a prompt or generation call. Exact native instance identity is reused for bus registration. Project sessions keep normal naming, model/auth, tools, plugins, notifications and review eligibility: they do not publish `managedAgent:sentinel`, receive Sentinel's prompt, or inherit its alias/quiet settings. Sentinel still uses `/sentinel-bootstrap`, managed lifecycle protocol 3 and its existing accessible quiet participant behavior.

Do not supply portal credentials, registry secrets, VAPID keys, or server configuration to the extension. Room links are capabilities: do not log or commit them. Broker authentication, per-PC identity, role authorization and opt-in steering remain enforced. Native input receipts read persisted host input; native voice commands are accepted only through the authenticated bus binding. Invalid/missing configuration leaves the extension unconnected rather than guessing a broker or identity.

## Ownership and integration

`src/extension/` owns the extension and real session-bus client. `src/shared/{protocol,machine-auth,machines,collab-input-receipts,session-consult}.ts` are local copies of wire contracts; the server retains independent copies. Coordinate future wire changes across both repositories without runtime cross-checkout imports or shims.

Public package exports are the root default extension plus `resolveSessionDisplayName`, and `./session-bus-client`, `./collab-registry`, `./native-input-receipt`, `./native-voice`, `./device-enrollment`. The enrollment subpath exposes the existing cross-platform credential parser, protected persistence, origin validation, and pairing flow without loading the native session extension. Consumers must keep device identity outside synchronized setup. Server development tests and separately compiled fleet installers may depend on a pinned Git commit of this package; production server dependency installation excludes that development dependency.

Moved tests: `extension-collab-lifecycle.integration.test.ts`, `native-input-receipt.test.ts`, `session-name.test.ts`. Broker/portal/reliability integration fixtures stay in the server repository and migrate their client imports to package exports. No server implementation, user guidance files, secrets, logs, temporary files or node_modules were copied into this repository.

## Release and licensing

Source candidate `0.8.0` adds ordinary app-launched project-session bootstrap/identity; `0.7.1` preserved complete native consultation replies. Runtime version `1.0.0` is a separate artifact and requires this package's managed runtime protocol 1 plus Sentinel protocol 3. Publication and activation require the parent integration gate; source edits are not a published release. Installation never restarts ordinary users. No npm publishing workflow is required. This repository declares no license grant; public visibility and installability alone do not grant general redistribution or modification rights.
