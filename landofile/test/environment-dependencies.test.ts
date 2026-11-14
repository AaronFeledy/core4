import { describe, expect, test } from "bun:test";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";
import {
  emptyEnvironmentDependencies,
  recordEnvironment,
  recordExpressionEnvironment,
  unionEnvironmentDependencies,
} from "../src/environment-dependencies.ts";
import {
  getLandofileEnvironmentDependencies,
  hasLandofileEnvironmentDependencies,
  rememberLandofileEnvironmentDependencies,
} from "../src/load-expression-provenance.ts";

describe("recordEnvironment view", () => {
  test("get/has/getOwnPropertyDescriptor record string names including unset", () => {
    const recorder = recordEnvironment({ PRESENT: "yes", EMPTY: "" });
    expect(recorder.view.PRESENT).toBe("yes");
    expect(recorder.view.EMPTY).toBe("");
    expect(recorder.view.MISSING).toBeUndefined();
    expect("PRESENT" in recorder.view).toBe(true);
    expect("MISSING" in recorder.view).toBe(false);
    expect(Object.getOwnPropertyDescriptor(recorder.view, "PRESENT")?.value).toBe("yes");
    expect(recorder.dependencies()).toEqual({
      _tag: "Names",
      names: ["EMPTY", "MISSING", "PRESENT"],
    });
  });

  test("ownKeys records Complete", () => {
    const recorder = recordEnvironment({ A: "1", B: "2" });
    expect(Object.keys(recorder.view).sort()).toEqual(["A", "B"]);
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });

  test("mutation traps return false and leave the snapshot unchanged", () => {
    const recorder = recordEnvironment({ KEEP: "1" });
    const view = recorder.view;
    expect(Reflect.set(view, "KEEP", "2")).toBe(false);
    expect(Reflect.defineProperty(view, "NEW", { value: "x" })).toBe(false);
    expect(Reflect.deleteProperty(view, "KEEP")).toBe(false);
    expect(recorder.view.KEEP).toBe("1");
    expect(recorder.view.NEW).toBeUndefined();
  });

  test("symbol keys are ignored", () => {
    const recorder = recordEnvironment({ A: "1" });
    const sym = Symbol("secret");
    expect(Reflect.get(recorder.view, sym)).toBeUndefined();
    expect(Reflect.has(recorder.view, sym)).toBe(false);
    expect(recorder.dependencies()).toEqual({ _tag: "Names", names: [] });
  });

  test("recordNames is a no-op after Complete", () => {
    const recorder = recordEnvironment({ A: "1" });
    Object.keys(recorder.view);
    recorder.recordNames(["Z"]);
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });
});

describe("recordExpressionEnvironment", () => {
  const parse = (source: string) => {
    const parsed = parseExpressionEither(source, {
      filePath: "/app/.lando.yml",
      bareShellParameters: "preserve",
    });
    if (Result.isFailure(parsed)) throw parsed.failure;
    return parsed.success;
  };

  test("records static env members including unset names", () => {
    const recorder = recordEnvironment({ SET: "1" });
    recordExpressionEnvironment(recorder, parse("{{ env.SET }}-{{ env.UNSET }}"));
    expect(recorder.dependencies()).toEqual({ _tag: "Names", names: ["SET", "UNSET"] });
  });

  test("marks Complete when env member is unanalyzable", () => {
    const recorder = recordEnvironment({ SET: "1" });
    recordExpressionEnvironment(recorder, parse("{{ env[app.name] }}"));
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });

  test("bare env scope is Complete", () => {
    const recorder = recordEnvironment({});
    recordExpressionEnvironment(recorder, parse("{{ env }}"));
    expect(recorder.dependencies()).toEqual({ _tag: "Complete" });
  });
});

describe("unionEnvironmentDependencies", () => {
  test("merges sorted unique names", () => {
    expect(
      unionEnvironmentDependencies(
        { _tag: "Names", names: ["b", "a"] },
        { _tag: "Names", names: ["a", "c"] },
        emptyEnvironmentDependencies(),
      ),
    ).toEqual({ _tag: "Names", names: ["a", "b", "c"] });
  });

  test("Complete wins over Names", () => {
    expect(unionEnvironmentDependencies({ _tag: "Names", names: ["a"] }, { _tag: "Complete" })).toEqual({
      _tag: "Complete",
    });
  });
});

describe("provenance side channel", () => {
  test("remembers and reads dependencies without a public field", () => {
    const landofile = { name: "app" };
    expect(hasLandofileEnvironmentDependencies(landofile)).toBe(false);
    expect(getLandofileEnvironmentDependencies(landofile)).toEqual(emptyEnvironmentDependencies());
    rememberLandofileEnvironmentDependencies(landofile, { _tag: "Names", names: ["FOO"] });
    expect(hasLandofileEnvironmentDependencies(landofile)).toBe(true);
    expect(getLandofileEnvironmentDependencies(landofile)).toEqual({
      _tag: "Names",
      names: ["FOO"],
    });
    expect(Object.keys(landofile)).toEqual(["name"]);
  });

  test("documents that raw values are never persisted on the dependency set", () => {
    const recorder = recordEnvironment({ SECRET: "super-secret-value", OTHER: "x" });
    expect(recorder.view.SECRET).toBe("super-secret-value");
    const deps = recorder.dependencies();
    expect(deps).toEqual({ _tag: "Names", names: ["SECRET"] });
    expect(JSON.stringify(deps)).not.toContain("super-secret-value");
  });
});
