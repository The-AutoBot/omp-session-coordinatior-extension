# Repository guidance

This repository owns only the OMP session coordinator client extension. Keep it independently installable; never introduce sibling-checkout imports, runtime shims, or copied server implementations. Use existing Bun/TypeScript patterns and preserve the authenticated wire contract.

Entrypoint: `src/extension/index.ts`. Public package subpaths expose the session-bus client, collab registry, native input receipts and native voice handler. Shared wire files are local copies also owned by the server repository; coordinate changes to both copies and their consumers explicitly.

Use `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`, and `bun run smoke` when verification is explicitly assigned. The smoke proves public package resolution and real loopback client transport against a schema-validated protocol peer, not actual broker integration or installed-host activation. Mixed broker/portal tests live in the server repository.

Never commit machine credentials, environment files, room capability links, logs, node_modules or disposable smoke artifacts. Never change installed OMP/SDK, user configuration, PATH or live sessions as part of repository development. Document registration without silently activating it. Automatic collab must continue using official public host/registry APIs; steering stays opt-in and broker authorization remains authoritative.

Extraction lessons: copy current working-tree bytes before authorizing source deletion, especially preexisting dirty extension files. Separate extension-only tests from mixed broker fixtures before moving ownership. A managed bootstrap can already include the extension, so do not assume a legacy launcher actually loads the standalone entrypoint.
