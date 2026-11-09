import { describe, expect, test } from "bun:test";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";

const journal = defineTransitions<"absent" | "open" | "closed">()({
  open: { from: ["absent"], to: "open", settledIn: ["open", "closed"] },
  touch: { from: ["open"] },
  close: { from: ["open"], to: "closed" },
});

describe("defineTransitions", () => {
  test("advances only along a declared edge, including an in-place rewrite", () => {
    expect(journal.step("open", "absent")).toEqual({ _tag: "Advance", from: "absent", to: "open" });
    expect(journal.step("touch", "open")).toEqual({ _tag: "Advance", from: "open", to: "open" });
    expect(journal.step("close", "absent")).toEqual({
      _tag: "Illegal",
      from: "absent",
      to: "closed",
      accepts: ["open"],
    });
  });

  test("treats a repeated operation as settled where its effect already holds", () => {
    expect(journal.step("open", "closed")).toEqual({ _tag: "Settled", from: "closed" });
    expect(journal.step("close", "closed")._tag).toBe("Illegal");
  });

  test("names the rejected edge and the accepted sources", () => {
    const verdict = journal.step("close", "absent");
    if (verdict._tag !== "Illegal") throw new Error("expected an illegal verdict");
    expect(illegalTransitionMessage("Journal j1", "close", verdict)).toBe(
      "Journal j1 cannot close while absent; close only moves open to closed.",
    );
    const rewrite = journal.step("touch", "closed");
    if (rewrite._tag !== "Illegal") throw new Error("expected an illegal verdict");
    expect(illegalTransitionMessage("Journal j1", "touch", rewrite)).toBe(
      "Journal j1 cannot touch while closed; touch only applies while open.",
    );
  });
});
