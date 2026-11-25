# ADR 0006: GitHub sync configuration block

`~/.ctx/config.json` includes an optional `github` block that defaults to disabled (`enabled: false`), `owner: ""`, `repos: []`, `cloneRoot: "~/code/github"`, `pollIntervalMinutes: 15` (minimum 5), `pushMode: "pr"` (locked), `branchPrefix: "ctx/auto-update"`, `allowPublicPush: false`, `maxReposPerRun: 50`, and `rateLimitBackoffSeconds: 60`.

Configuration validation rejects `pollIntervalMinutes < 5`, `pushMode` values other than `"pr"`, non-boolean `enabled` or `allowPublicPush`, `repos` entries outside `owner/repo` format, `cloneRoot` outside the home directory, and any token-like keys or values. Tokens remain strictly in the Keychain.
