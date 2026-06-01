import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  normalizeScratchStartArgv,
  scratchStart,
  scratchStartOptionsFromInput,
} from "../../src/cli/commands/scratch.ts";
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

describe("apps:scratch:start --isolate flag mapping", () => {
  test("scratchStartOptionsFromInput reads a valid isolate mode and defaults to undefined", () => {
    expect(scratchStartOptionsFromInput({ flags: { fork: true, isolate: "full" } }).isolate).toBe("full");
    expect(scratchStartOptionsFromInput({ flags: { fork: true, isolate: "none" } }).isolate).toBe("none");
    expect(scratchStartOptionsFromInput({ flags: { fork: true } }).isolate).toBeUndefined();
    expect(scratchStartOptionsFromInput({ flags: { fork: true, isolate: "bogus" } }).isolate).toBeUndefined();
  });

  test("parseScratchStartArgv mirrors --isolate parsing (dual-dispatch parity)", () => {
    expect(parseScratchStartArgv(["--fork", "--isolate", "full"]).isolate).toBe("full");
    expect(parseScratchStartArgv(["--fork", "--isolate=full"]).isolate).toBe("full");
    expect(parseScratchStartArgv(["--fork", "--isolate=none"]).isolate).toBe("none");
    expect(parseScratchStartArgv(["--fork"]).isolate).toBeUndefined();
    expect(parseScratchStartArgv(["--fork", "--isolate=bogus"]).isolate).toBeUndefined();
  });
});

describe("apps:scratch:start --mount-cwd / --share-global-storage flag mapping", () => {
  test("scratchStartOptionsFromInput reads mount-cwd (bare/value) and share-global-storage", () => {
    expect(scratchStartOptionsFromInput({ flags: { fork: true } }).mountCwd).toBeUndefined();
    expect(scratchStartOptionsFromInput({ flags: { fork: true } }).shareGlobalStorage).toBeUndefined();
    expect(scratchStartOptionsFromInput({ flags: { fork: true, "mount-cwd": "" } }).mountCwd).toEqual({});
    expect(
      scratchStartOptionsFromInput({ flags: { fork: true, "mount-cwd": "/srv/site" } }).mountCwd,
    ).toEqual({ target: "/srv/site" });
    expect(
      scratchStartOptionsFromInput({ flags: { fork: true, "share-global-storage": true } })
        .shareGlobalStorage,
    ).toBe(true);
  });

  test("parseScratchStartArgv mirrors mount-cwd / share-global-storage (dual-dispatch parity)", () => {
    expect(parseScratchStartArgv(["--fork", "--mount-cwd"]).mountCwd).toEqual({});
    expect(parseScratchStartArgv(["--fork", "--mount-cwd="]).mountCwd).toEqual({});
    expect(parseScratchStartArgv(["--fork", "--mount-cwd=/srv/site"]).mountCwd).toEqual({
      target: "/srv/site",
    });
    expect(parseScratchStartArgv(["--fork"]).mountCwd).toBeUndefined();
    expect(parseScratchStartArgv(["--fork", "--share-global-storage"]).shareGlobalStorage).toBe(true);
    expect(parseScratchStartArgv(["--fork"]).shareGlobalStorage).toBeUndefined();
  });

  test("normalizeScratchStartArgv rewrites bare --mount-cwd for oclif's string flag", () => {
    expect(normalizeScratchStartArgv(["--fork", "--mount-cwd"])).toEqual(["--fork", "--mount-cwd="]);
    expect(normalizeScratchStartArgv(["--fork", "--mount-cwd=/x"])).toEqual(["--fork", "--mount-cwd=/x"]);
    expect(normalizeScratchStartArgv(["--fork", "--share-global-storage"])).toEqual([
      "--fork",
      "--share-global-storage",
    ]);
  });
});
