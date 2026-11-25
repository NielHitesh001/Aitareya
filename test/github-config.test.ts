import assert from "node:assert/strict";
import test from "node:test";
import { defaultGithubConfig, parseConfig } from "../src/config.ts";

test("github config defaults when absent", () => {
  const config = parseConfig({}, "/Users/test");
  assert.deepEqual(config.github, defaultGithubConfig);
});

test("github config round-trips a valid block without change", () => {
  const github = {
    enabled: true,
    owner: "NielHitesh001",
    repos: ["NielHitesh001/Aitareya", "NielHitesh001/HERMES"],
    cloneRoot: "~/code/github",
    pollIntervalMinutes: 20,
    pushMode: "pr" as const,
    branchPrefix: "ctx/auto-update",
    allowPublicPush: true,
    maxReposPerRun: 25,
    rateLimitBackoffSeconds: 120,
  };
  const parsed = parseConfig({ github }, "/Users/test");
  assert.deepEqual(parsed.github, github);
});

test("github config rejects pollIntervalMinutes below 5", () => {
  assert.throws(
    () => parseConfig({ github: { pollIntervalMinutes: 4 } }, "/Users/test"),
    /github\.pollIntervalMinutes must be an integer of at least 5\./,
  );
});

test("github config rejects pushMode other than pr", () => {
  assert.throws(
    () => parseConfig({ github: { pushMode: "direct" } }, "/Users/test"),
    /github\.pushMode is locked to pr in v1\./,
  );
});

test("github config rejects non-boolean enabled and allowPublicPush", () => {
  assert.throws(
    () => parseConfig({ github: { enabled: "true" } }, "/Users/test"),
    /github\.enabled must be boolean\./,
  );
  assert.throws(
    () => parseConfig({ github: { allowPublicPush: 1 } }, "/Users/test"),
    /github\.allowPublicPush must be boolean\./,
  );
});

test("github config rejects repos entries that are not owner/repo", () => {
  assert.throws(
    () => parseConfig({ github: { repos: ["just-a-repo"] } }, "/Users/test"),
    /github\.repos must be an array of owner\/repo strings\./,
  );
  assert.throws(
    () => parseConfig({ github: { repos: ["owner/repo/extra"] } }, "/Users/test"),
    /github\.repos must be an array of owner\/repo strings\./,
  );
});

test("github config rejects token-like keys or values anywhere in the block", () => {
  assert.throws(
    () => parseConfig({ github: { token: "anything" } }, "/Users/test"),
    /Keychain/,
  );
  assert.throws(
    () => parseConfig({ github: { owner: "ghp_FakeTokenValueForTesting123456" } }, "/Users/test"),
    /Keychain/,
  );
  assert.throws(
    () => parseConfig({ github: { repos: ["owner/github_pat_FakeTokenValue123456"] } }, "/Users/test"),
    /Keychain/,
  );
});

test("github config rejects cloneRoot outside the home directory", () => {
  assert.throws(
    () => parseConfig({ github: { cloneRoot: "/tmp/github" } }, "/Users/test"),
    /github\.cloneRoot must resolve inside the home directory\./,
  );
  assert.throws(
    () => parseConfig({ github: { cloneRoot: "~/../outside" } }, "/Users/test"),
    /github\.cloneRoot must resolve inside the home directory\./,
  );
});
