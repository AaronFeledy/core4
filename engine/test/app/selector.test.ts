import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import type { AppSelector } from "@lando/sdk/app";
import type { AbsolutePath, LandofileShape } from "@lando/sdk/schema";

import { normalizeAppSelector } from "../../src/app/selector.ts";

const abs = (value: string): AbsolutePath => value as AbsolutePath;

describe("normalizeAppSelector", () => {
  test("no selector resolves from cwd by default", () => {
    const result = normalizeAppSelector(undefined);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.kind).toBe("cwd");
  });

  test("a cwd-only selector classifies as cwd", () => {
    const result = normalizeAppSelector({ cwd: abs("/work/app") });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result) && result.right.kind === "cwd") {
      expect(result.right.cwd).toBe("/work/app");
    }
  });

  test("id takes precedence and carries optional root/cwd", () => {
    const result = normalizeAppSelector({ id: "myapp", root: abs("/work/app") });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result) && result.right.kind === "id") {
      expect(result.right.id).toBe("myapp");
      expect(result.right.root).toBe("/work/app");
    }
  });

  test("a string landofile selector classifies as a path", () => {
    const result = normalizeAppSelector({ landofile: abs("/work/app/.lando.yml") });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.kind).toBe("landofile-path");
  });

  test("a decoded Landofile selector without a root fails with missing-root", () => {
    const shape = { name: "myapp" } as unknown as LandofileShape;
    const result = normalizeAppSelector({ landofile: shape } as unknown as AppSelector);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("AppResolveError");
      expect(result.left.reason).toBe("missing-root");
    }
  });

  test("a decoded Landofile selector with a root classifies as landofile-shape", () => {
    const shape = { name: "myapp" } as unknown as LandofileShape;
    const result = normalizeAppSelector({ landofile: shape, root: abs("/work/app") });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.kind).toBe("landofile-shape");
  });

  test("combining id and landofile is ambiguous", () => {
    const result = normalizeAppSelector({
      id: "myapp",
      landofile: abs("/work/app/.lando.yml"),
    } as unknown as AppSelector);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("AppResolveError");
      expect(result.left.reason).toBe("ambiguous");
    }
  });

  test("a root-only selector classifies as root", () => {
    const result = normalizeAppSelector({ root: abs("/work/app") });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result) && result.right.kind === "root") {
      expect(result.right.root).toBe("/work/app");
    }
  });
});
