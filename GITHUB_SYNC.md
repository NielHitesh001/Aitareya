# GITHUB_SYNC.md: GitHub Sync Spec (Build-Order Step 12)

## Goal

Keep a local mirror of the user's GitHub repos, pull remote changes, rescan on changes, and propose context updates back to GitHub through pull requests. Never broad account control.

## Non-negotiable limits

- **No destructive actions:** never delete repos or branches, force-push, rewrite history, change visibility, collaborators, secrets, Actions, Settings, or webhooks, or transfer or archive repos.
- **Branch & PR only:** pushes only to `ctx/auto-update` branches, only via PR. Never push to `main` or any user branch. Never merge PRs.
- **Allowed commit paths:** `ctx` may commit only `context/`, `AGENTS.md`, `CLAUDE.md`, and `.cursorrules`. Never commit code, lockfiles, or `.env*`, `*.pem`, `*.key`, `credentials*`.
- **Allowlist only:** only repos in config `github.repos` are cloned or synced. Newly discovered repos are reported, not cloned, until approved with `ctx github allow`.
- **Public repos:** no pushes unless `github.allowPublicPush` is `true` (default `false`).
- **Token safety:** token stays in the Keychain. Never write it to config, logs, index, errors, or tests.

## Auth

- Use `gh` CLI. `ctx github login` runs `gh auth login` if needed.
- Preferred token: fine-grained personal access token with:
  - Contents: read/write
  - Pull requests: read/write
  - Metadata: read
- `ctx doctor` warns if scopes are broader.

## Config block (`github`)

```json
{
  "github": {
    "enabled": false,
    "owner": "",
    "repos": [],
    "cloneRoot": "~/code/github",
    "pollIntervalMinutes": 15,
    "pushMode": "pr",
    "branchPrefix": "ctx/auto-update",
    "allowPublicPush": false,
    "maxReposPerRun": 50,
    "rateLimitBackoffSeconds": 60
  }
}
```

- `pollIntervalMinutes`: minimum `5` (default `15`).
- `pushMode`: `"pr"` (only option).
- `allowPublicPush`: default `false`.

## Commands

- `ctx github login` — authenticate via `gh auth login` if needed.
- `ctx github discover` — list/report newly discovered repos (no clone).
- `ctx github allow <owner/repo>` — add repo to allowlist, clone, and `ctx init`.
- `ctx github deny <owner/repo>` — remove repo from allowlist (never deletes clone).
- `ctx github pull` — fetch and fast-forward pull allowlisted repos.
- `ctx github status` — report sync/repo status.
- `ctx github push-context` — propose context updates via PR (requires `--yes` or interactive confirm).
- `ctx github daemon` — run the GitHub sync poll loop.

## Clone and pull

- Clone over HTTPS with `gh` credential helper; never embed token in URL.
- Pull with `git fetch --prune` then `git merge --ff-only`. Never rebase or `git reset --hard`.
- Diverged branch: change nothing, mark diverged.
- Dirty tree: skip and report; no stash.
- Rate limit: back off (`rateLimitBackoffSeconds`), retry once, continue.

## Push flow (per repo)

1. Skip public repos unless `github.allowPublicPush` is `true`.
2. Run `ctx sync --dry-run`.
3. Run `scrub` on the diff and abort on any match (report kind only).
4. Base on origin default branch or existing `ctx/auto-update` branch.
5. Stage allowed paths only (`context/`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`).
6. Commit `"ctx: update shared context (<sha>)"`.
7. Push without force.
8. Open or update PR titled `"ctx: shared context update"`. Never merge.
9. Restore user's branch. Use a temporary worktree if the clone is dirty.

## Logging

- Log to `~/.ctx/logs/github.log`.
- Rotate at 5MB, keeping 3 files.
- Never log tokens or file/diff content.

## Build order (one step at a time, tests each)

1. `login` and `ctx doctor` scope checks.
2. Config additions (`github` block and validation).
3. `discover`, `allow`, `deny`.
4. `allow` clones, `pull` with `--ff-only`.
5. `status`.
6. `push-context` with PR flow tested on local bare remotes.
7. `daemon` loop.

## Tests

- Config validation including the 5-minute `pollIntervalMinutes` floor.
- Allowlist enforcement.
- Allowed-path filter.
- Public-repo guard.
- Scrub-abort on diff match.
- Integration tests with local bare repos for: clone, fast-forward pull, diverged detection, dirty skip, and PR branch creation with a stub `gh` on `PATH`.
- Source grep test failing on `push --force`, `branch -D`, `repo delete`, or `gh repo` mutations.
- Rate-limit backoff with a mocked `429`.

## Open decisions (do not guess; ask before implementing)

1. Default branch name when `origin/HEAD` is unset.
2. PR reviewers (none by default).
3. Whether `discover` prints private repo names or only a count.
