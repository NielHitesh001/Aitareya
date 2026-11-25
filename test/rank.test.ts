import assert from "node:assert/strict";
import test from "node:test";
import { rank, withinTokenBudget, type RankedChunk } from "../src/rank.ts";
const chunk = (id: string, sourceType: RankedChunk["sourceType"] = "doc", text = "text"): RankedChunk => ({ id, project: "project", path: `${id}.md`, startLine: 1, endLine: 1, sourceType, text });

test("RRF favors a chunk ranked by both sources", () => { const both = chunk("both"); assert.equal(rank({ fts: [chunk("fts"), both], vectors: [chunk("vector"), both] })[0].id, "both"); });
test("tier resolves equal fusion scores", () => { const rule = chunk("rule", "rule"); const decision = chunk("decision", "decision"); const results = rank({ fts: [rule, decision], vectors: [decision, rule] }); assert.equal(results[0].sourceType, "rule"); assert.equal(results[1].sourceType, "decision"); });
test("edit boost moves a result and zero preserves ranking", () => { const first = chunk("first"); const edited = chunk("edited"); assert.deepEqual(rank({ fts: [first, edited], editedPaths: new Set([edited.path]), editBoost: 0 }).map((x) => x.id), ["first", "edited"]); assert.equal(rank({ fts: [first, edited], editedPaths: new Set([edited.path]), editBoost: 1 }).at(0)?.id, "edited"); });
test("budget skips oversized chunks without truncating and stops when none fit", () => { const large = chunk("large", "doc", "x".repeat(40)); const small = chunk("small", "doc", "tiny"); assert.deepEqual(withinTokenBudget({ fts: [large, small], tokenBudget: 2 }).map((x) => x.id), ["small"]); assert.deepEqual(withinTokenBudget({ fts: [large], tokenBudget: 2 }), []); });
test("rejects missing provenance", () => { assert.throws(() => rank({ fts: [{ ...chunk("bad"), project: "" }] }), /provenance/); });
test("keyword-only preserves FTS order when tiers and boost do not apply", () => { assert.deepEqual(rank({ fts: [chunk("one"), chunk("two"), chunk("three")] }).map((x) => x.id), ["one", "two", "three"]); });
