# ctx handoff

## Current state

- Engine build-order steps 1–11 are implemented; the latest full suite passed
  53 tests with `npm test`.
- Step 12 (GitHub sync) has not started.
- Companion steps 1–2 are implemented and covered by XCTest. Later companion
  phases have not started.
- Launchd job generation is implemented and tested, but no real job has been
  loaded.
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
