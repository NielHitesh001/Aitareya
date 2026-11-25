# ctx handoff

## Current state

- Engine build-order steps 1–11 are implemented; build fix landed at `ff94c38`,
  and the full suite passes 54/54 tests (`npm test`).
- Item 4 (projects registered) is complete in `~/.ctx/config.json`:
  - `/Volumes/Niel/Assistant /HERMES`
  - `/Volumes/Niel/Assistant /Fort`
  - `/Volumes/Niel/Assistant /Bank_money-`
  - `/Volumes/Niel/Assistant /Bastion`
  - `/Volumes/Niel/Assistant /Blockhouse`
- Launchd jobs `sh.ctx.watch` and `sh.ctx.api` are loaded and verified
  (`runs = 1`, no exits, `~/.ctx/ctx.sock` secure).
- Watcher verified by the HERMES probe (`scanned 26` in
  `~/.ctx/logs/daemon.log`; probe file removed).
- Remaining: GitHub sync (`GITHUB_SYNC.md` steps 1–7) and companion steps 3–8.
- `GITHUB_SYNC.md` is in place (`da37c5f`); GitHub sync implementation has not started.
- Classic gh token carries admin:public_key, gist, read:org. Doctor warns. Replace with a fine-grained token scoped to the five repos to clear the warning.
- Companion steps 1–2 are implemented and covered by XCTest. Later companion
  phases have not started.
- Sessions remain deferred; no `SESSIONS.md` exists.

## Launchd prerequisites

1. Register only intended Git repositories in `config.projects`.
2. Regenerate the two plists using `/opt/homebrew/bin/node` and a PATH that
   includes `/opt/homebrew/bin`.
3. Review the generated plists, run `ctx doctor`, then obtain confirmation
   before calling `ctx daemon install`.
4. Verify both jobs, `~/.ctx/ctx.sock` mode `0600`, and daemon logs; test
   uninstall while preserving `~/.ctx`, then reinstall.

Background access to `/Volumes/Niel` may require a macOS privacy grant for
the Node binary. Do not broaden job permissions.

## Working rules

- Read `AGENTS.md` first.
- Do not change the protocol, socket behavior, configuration schema, Store
  schema, or MCP tool names without approval.
- ADRs are in `context/decisions/0001` through `0005`.
- Complete one build-order step at a time and report the exact `npm test`
  output after every step.
