import { describe, expect, test } from "bun:test";

import {
  CompiledBinaryVersionError,
  assertCompiledBinaryVersion,
  isPlaceholderCoreVersion,
  normalizeCompiledBinaryVersion,
  resolveCompiledBinaryVersion,
} from "../../../scripts/compiled-binary-version.ts";

describe("compiled binary version", () => {
  test("treats 0.0.0 and 0.0.0 prereleases as placeholders", () => {
    expect(isPlaceholderCoreVersion("0.0.0")).toBe(true);
    expect(isPlaceholderCoreVersion("v0.0.0")).toBe(true);
    expect(isPlaceholderCoreVersion("0.0.0-dev")).toBe(true);
    expect(isPlaceholderCoreVersion("0.0.0+deadbeef")).toBe(true);
    expect(isPlaceholderCoreVersion("4.0.0-dev.821")).toBe(false);
  });

  test("normalizes git describe tags into a 4.x prerelease", () => {
    expect(normalizeCompiledBinaryVersion("v4.0.0-dev.821")).toBe("4.0.0-dev.821");
    expect(normalizeCompiledBinaryVersion("v4.0.0-dev.821-3-g2c29d89")).toBe("4.0.0-dev.821+3.g2c29d89");
    expect(normalizeCompiledBinaryVersion("v4.0.0-dev.821-3-g2c29d89-dirty")).toBe(
      "4.0.0-dev.821+3.g2c29d89.dirty",
    );
    expect(normalizeCompiledBinaryVersion("4.0.0-beta.1")).toBe("4.0.0-beta.1");
  });

  test("promotes a bare SHA to a 4.x dev build", () => {
    expect(normalizeCompiledBinaryVersion("2c29d89")).toBe("4.0.0-dev+2c29d89");
    expect(normalizeCompiledBinaryVersion("2c29d89-dirty")).toBe("4.0.0-dev+2c29d89.dirty");
  });

  test("resolves explicit and env versions before git describe", () => {
    expect(
      resolveCompiledBinaryVersion({
        explicit: "v4.0.0-alpha.12",
        describe: () => "should-not-run",
      }),
    ).toBe("4.0.0-alpha.12");
    expect(
      resolveCompiledBinaryVersion({
        env: { LANDO_RELEASE_VERSION: "4.0.0-beta.3" },
        describe: () => "should-not-run",
      }),
    ).toBe("4.0.0-beta.3");
    expect(
      resolveCompiledBinaryVersion({
        env: { LANDO_CORE_VERSION: "4.0.0-alpha.7" },
        describe: () => "should-not-run",
      }),
    ).toBe("4.0.0-alpha.7");
  });

  test("falls back to git describe when no explicit version is supplied", () => {
    expect(
      resolveCompiledBinaryVersion({
        env: {},
        describe: () => "v4.0.0-dev.821-1-gabc1234",
      }),
    ).toBe("4.0.0-dev.821+1.gabc1234");
  });

  test("derives 4.x from a SHA when tags are missing", () => {
    expect(
      resolveCompiledBinaryVersion({
        env: {},
        describe: () => "a229496186e0",
      }),
    ).toBe("4.0.0-dev+a229496186e0");
    expect(
      resolveCompiledBinaryVersion({
        env: {},
        describe: () => undefined,
        revParse: () => "a229496186e0",
      }),
    ).toBe("4.0.0-dev+a229496186e0");
  });

  test("refuses placeholder stamps from explicit or env override", () => {
    expect(() => resolveCompiledBinaryVersion({ explicit: "0.0.0" })).toThrow(CompiledBinaryVersionError);
    expect(() =>
      resolveCompiledBinaryVersion({
        env: { LANDO_CORE_VERSION: "0.0.0" },
        describe: () => "4.0.0-dev.821",
      }),
    ).toThrow(CompiledBinaryVersionError);
    expect(() => assertCompiledBinaryVersion("0.0.0")).toThrow(CompiledBinaryVersionError);
    expect(assertCompiledBinaryVersion("4.0.0-dev.821")).toBe("4.0.0-dev.821");
  });

  test("skips a placeholder describe and uses the commit SHA", () => {
    expect(
      resolveCompiledBinaryVersion({
        env: {},
        describe: () => "0.0.0-dev",
        revParse: () => "deadbeef",
      }),
    ).toBe("4.0.0-dev+deadbeef");
  });

  test("fails closed when no 4.x stamp can be derived", () => {
    expect(() =>
      resolveCompiledBinaryVersion({
        env: {},
        describe: () => undefined,
        revParse: () => undefined,
      }),
    ).toThrow(CompiledBinaryVersionError);
  });
});
