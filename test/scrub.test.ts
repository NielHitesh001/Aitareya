import assert from "node:assert/strict";
import test from "node:test";
import { scrub, scrubChunks } from "../src/scrub.ts";

const cases: Array<[string, string, string]> = [
  ["aws-key", "AKIA1234567890ABCDEF", "aws-key"],
  ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz123456", "github-token"],
  ["github-token", "github_pat_abcdefghijklmnopqrstuvwxyz_123456", "github-token"],
  ["slack-token", "xoxb-1234567890-example", "slack-token"],
  ["stripe-key", "sk_live_1234567890abcdef", "stripe-key"],
  ["assignment", "password=demo-value", "assignment"],
  ["pem-private-key", "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----", "pem-private-key"],
  ["jwt", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZW1vIn0.signature", "jwt"],
  ["high-entropy-key", "api_key=Q9vM2nL7pR4sT8wX1yZ3aB5cD6eF0gHj", "high-entropy-key"],
];

for (const [name, fixture, kind] of cases) {
  test(`redacts ${name}`, () => {
    const result = scrub(`const value = ${fixture}`);
    assert.match(result.text, new RegExp(`\\[REDACTED:${kind}\\]`));
    assert.deepEqual(result.redactions, [{ kind, count: 1 }]);
  });
}

test("leaves ordinary code unchanged", () => {
  const source = "export function add(left: number, right: number) { return left + right; }";
  assert.deepEqual(scrub(source), { text: source, redactions: [] });
});

test("skips a chunk if its scrubber throws", () => {
  const results = scrubChunks(["safe", "drop"], (chunk) => {
    if (chunk === "drop") throw new Error("scrub failure");
    return scrub(chunk);
  });
  assert.deepEqual(results, [{ text: "safe", redactions: [] }]);
});
