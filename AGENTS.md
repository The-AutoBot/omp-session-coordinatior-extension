# Repository guidance

This repository owns only the OMP session coordinator client extension. Keep it independently installable; never introduce sibling-checkout imports, runtime shims, or copied server implementations. Use existing Bun/TypeScript patterns and preserve the authenticated wire contract.

Entrypoint: `src/extension/index.ts`. Public package subpaths expose the session-bus client, collab registry, native input receipts and native voice handler. Shared wire files are local copies also owned by the server repository; coordinate changes to both copies and their consumers explicitly.

Native installation is declared by `package.json#omp.extensions`; keep the existing package exports for server development consumers. GitHub releases use explicit refs (initial `v0.1.0`); retain `private: true` unless npm publication is separately requested. Do not invent a license grant. Use the official `omp plugin install`, `upgrade <package-name>` and `uninstall <package-name>` lifecycle; verify syntax with the current native CLI/read-only upstream docs before changing installation guidance.

Code download is separate from per-PC broker enrollment and secret provisioning. Never imply installation grants coordinator access or permission. Register exactly once: plugin discovery must not coexist with legacy `-e`, settings or managed-bootstrap copies of this extension. Source activation/unloading requires a user-directed full OMP restart/resume, not `/reload`; leave active users untouched. Native qualification belongs in a dedicated owned `omp --profile <name>` profile; Git/npm `--scope project` is not isolation. Keep protocol-peer smoke, actual disposable broker proof and installed native-host proof distinct.

For native qualification, use a sanitized child environment and an owned `PI_CONFIG_DIR` as well as a named profile: some daemon paths are shared across profiles under the base root. Headless participant RPC can prove manifest discovery through native command enumeration and matching broker/native session identity without sending a prompt. Stop the owned native process before uninstalling; reconcile broker disconnection and listener closure before deleting its temporary configuration.

Use `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`, and `bun run smoke` when verification is explicitly assigned. The smoke proves public package resolution and real loopback client transport against a schema-validated protocol peer, not actual broker integration or installed-host activation. Mixed broker/portal tests live in the server repository.

Never commit machine credentials, environment files, room capability links, logs, node_modules or disposable smoke artifacts. Never change installed OMP/SDK, user configuration, PATH or live sessions as part of repository development. Document registration without silently activating it. Automatic collab must continue using official public host/registry APIs; steering stays opt-in and broker authorization remains authoritative.

Extraction lessons: copy current working-tree bytes before authorizing source deletion, especially preexisting dirty extension files. Separate extension-only tests from mixed broker fixtures before moving ownership. A managed bootstrap can already include the extension, so do not assume a legacy launcher actually loads the standalone entrypoint.
