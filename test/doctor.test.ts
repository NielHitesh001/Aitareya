import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/doctor.ts";

test("doctor reports config without exposing tokens", async () => {
  const report = await doctor(async () => ({ allowlist: ["/Users/test/code/github/repo"], pollIntervalMinutes: 5, pushMode: "pr", publicPush: false }), "/path/that/does/not/exist");
  assert.deepEqual(report.config, { valid: true, allowlistedRepoCount: 1 });
  assert.equal(report.socket.state, "missing");
  assert.equal(report.githubToken, "keychain-only");
});
