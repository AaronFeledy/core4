import { describe, expect, test } from "bun:test";

import { Result } from "effect";

import type { AppSelector } from "@lando/sdk/app";
import type { AbsolutePath, LandofileShape } from "@lando/sdk/schema";

import { normalizeAppSelector } from "../../src/app/selector.ts";

const abs = (value: string): AbsolutePath => value as AbsolutePath;

describe("normalizeAppSelector", () => {
  test("no selector resolves from cwd by default", () => {
    const result = normalizeAppSelector(undefined);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.kind).toBe("cwd");
  });

  test("a cwd-only selector classifies as cwd", () => {
    const result = normalizeAppSelector({ cwd: abs("/work/app") });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result) && result.success.kind === "cwd") {
      expect(result.success.cwd).toBe("/work/app");
    }
  });

  test("id takes precedence and carries optional root/cwd", () => {
    const result = normalizeAppSelector({ id: "myapp", root: abs("/work/app") });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result) && result.success.kind === "id") {
      expect(result.success.id).toBe("myapp");
      expect(result.success.root).toBe("/work/app");
    }
  });

  test("a string landofile selector classifies as a path", () => {
    const result = normalizeAppSelector({ landofile: abs("/work/app/.lando.yml") });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.kind).toBe("landofile-path");
  });

  test("a decoded Landofile selector without a root fails with missing-root", () => {
    const shape = { name: "myapp" } as unknown as LandofileShape;
    const result = normalizeAppSelector({ landofile: shape } as unknown as AppSelector);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("AppResolveError");
      expect(result.failure.reason).toBe("missing-root");
    }
  });

  test("a decoded Landofile selector with a root classifies as landofile-shape", () => {
    const shape = { name: "myapp" } as unknown as LandofileShape;
    const result = normalizeAppSelector({ landofile: shape, root: abs("/work/app") });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.kind).toBe("landofile-shape");
  });

  test("combining id and landofile is ambiguous", () => {
    const result = normalizeAppSelector({
      id: "myapp",
      landofile: abs("/work/app/.lando.yml"),
    } as unknown as AppSelector);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("AppResolveError");
      expect(result.failure.reason).toBe("ambiguous");
    }
  });

  test("a root-only selector classifies as root", () => {
    const result = normalizeAppSelector({ root: abs("/work/app") });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result) && result.success.kind === "root") {
      expect(result.success.root).toBe("/work/app");
    }
  });
});
