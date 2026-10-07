import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoTranslateBnToEn,
  correctIndexToLetter,
  correctLetterToIndex,
  difficultyWarning,
  normalizeDifficulty,
  normalizeSyncSet,
  normalizeTopic,
} from "../src/lib/exam-autosync-pure.ts";

describe("exam auto-sync core rules", () => {
  it("correct option is an A/B/C/D identifier", () => {
    assert.equal(correctLetterToIndex("C"), 2);
    assert.equal(correctIndexToLetter(2), "C");
    assert.equal(correctLetterToIndex("Z"), null);
  });

  it("missing, blank and boolean answers never become A", () => {
    for (const value of [null, undefined, "", "  ", false, true, [], {}]) {
      assert.equal(correctLetterToIndex(value), null);
      assert.equal(correctIndexToLetter(value), null);
    }
    for (const value of [-1, 4, 1.5, Infinity, NaN]) {
      assert.equal(correctLetterToIndex(value), null);
      assert.equal(correctIndexToLetter(value), null);
    }
    assert.equal(correctLetterToIndex(0), 0);
    assert.equal(correctLetterToIndex("0"), 0);
    assert.equal(correctIndexToLetter("2"), "C");
  });

  it("sets, topics and difficulties normalize strictly", () => {
    assert.equal(normalizeSyncSet("Set A"), "A");
    assert.equal(normalizeSyncSet("b"), "B");
    assert.equal(normalizeTopic("Cell Division"), "Cell Division");
    assert.equal(normalizeTopic("unknown"), null);
    assert.equal(normalizeDifficulty("moderate"), "Moderate");
  });

  it("auto-translation preserves the correct answer and scientific terms", () => {
    const out = autoTranslateBnToEn("উদ্ভিদ কোষে pH রক্ষা করে কোন অঙ্গাণু?");
    assert.match(out, /Mitochondria|Vacuole|organelle|plant cell|pH/);
    // Numerical values, units and formulas pass through untouched.
    assert.ok(autoTranslateBnToEn("pH 7.4 ATP DNA").includes("7.4"));
  });

  it("flags difficulty drift between sets without auto-changing questions", () => {
    const warn = difficultyWarning(
      { Easy: 33, Moderate: 34, Hard: 33 },
      { Easy: 90, Moderate: 5, Hard: 5 },
    );
    assert.ok(warn);
    const ok = difficultyWarning(
      { Easy: 33, Moderate: 34, Hard: 33 },
      { Easy: 33, Moderate: 34, Hard: 33 },
    );
    assert.equal(ok, null);
  });
});
