import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { scratchStart, scratchStartOptionsFromInput } from "../../src/cli/commands/scratch.ts";
import { parseScratchStartArgv } from "../../src/cli/run.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const failureTag = async <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<string> => {
  const result = await Effect.runPromise(
    effect.pipe(Effect.provide(makeLandoRuntime({ bootstrap: "scratch" })), Effect.either),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Right") throw new Error("expected scratch start to fail");
  return (result.left as { readonly _tag?: string })._tag ?? "";
};

describe("apps:scratch:start recipe flag mapping", () => {
  test("scratchStartOptionsFromInput maps recipe answer/option/yes/no-interactive flags", () => {
    const options = scratchStartOptionsFromInput({
      flags: {
        from: "lamp",
        answer: ["php=8.2", "name=ignored"],
        option: ["php=8.4"],
        yes: true,
        "no-interactive": true,
      },
    });
    expect(options.from).toBe("lamp");
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    // --option wins over --answer on a key collision (merge order: answers then options).
    expect(options.answers).toEqual({ php: "8.4", name: "ignored" });
  });

  test("parseScratchStartArgv mirrors the OCLIF flag mapping (dual-dispatch parity)", () => {
    const options = parseScratchStartArgv([
      "--from",
      "lamp",
      "--answer",
      "php=8.2",
      "--answer",
      "name=ignored",
      "--option",
      "php=8.4",
      "--yes",
      "--no-interactive",
    ]);
    expect(options.from).toBe("lamp");
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.answers).toEqual({ php: "8.4", name: "ignored" });
  });

  test("rejects passing both --fork and --from", async () => {
    expect(await failureTag(scratchStart({ fork: true, from: "lamp" }))).toBe("ScratchSourceUnresolvedError");
  });
});
