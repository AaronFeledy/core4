import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import * as SDK from "@lando/sdk/schema";

const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" });

describe("SqliteTargetConfig", () => {
  test("accepts an app-mount-relative POSIX path", () => {
    const decoded = Schema.decodeUnknownSync(SDK.SqliteTargetConfig)({ path: "data/site.sqlite" });
    expect(decoded).toEqual({ path: "data/site.sqlite" });
    expect(SDK.isSqliteAppRelativePath("data/site.sqlite")).toBe(true);
  });

  test("round-trips through ServiceConfigInput and LandofileShape", () => {
    const input = {
      name: "sqlite-app",
      services: { appserver: { type: "php:8.3", sqlite: { path: "db/app.sqlite" } } },
    };
    const once = Schema.decodeUnknownSync(SDK.LandofileShape)(input);
    const twice = Schema.decodeUnknownSync(SDK.LandofileShape)(once);
    expect(twice).toEqual(once);
    expect(
      strictDecode(SDK.ServiceConfigInput, { type: "php:8.3", sqlite: { path: "db/app.sqlite" } })._tag,
    ).toBe("Success");
  });

  test.each([
    "",
    "/abs.sqlite",
    "C:db.sqlite",
    "data\\site.sqlite",
    "data//site.sqlite",
    "data/../site.sqlite",
  ])("rejects sqlite.path %j", (path) => {
    expect(SDK.isSqliteAppRelativePath(path)).toBe(false);
    expect(SDK.sqliteAppRelativePathIssue(path)).toBeDefined();
    expect(Result.isFailure(strictDecode(SDK.SqliteTargetConfig, { path }))).toBe(true);
  });

  test("rejects unknown members under sqlite", () => {
    expect(strictDecode(SDK.SqliteTargetConfig, { path: "db.sqlite", extra: true })._tag).toBe("Failure");
  });
});

describe("ServiceCredsDisplay sqlite arm", () => {
  test("accepts engine and path without inventing server credentials", () => {
    const decoded = Schema.decodeUnknownSync(SDK.ServiceCredsDisplay)({
      engine: "sqlite",
      path: "data/site.sqlite",
    });
    expect(decoded).toEqual({ engine: "sqlite", path: "data/site.sqlite" });
  });

  test("rejects mixing sqlite engine with server credential fields", () => {
    expect(
      strictDecode(SDK.ServiceCredsDisplay, {
        engine: "sqlite",
        path: "data/site.sqlite",
        user: "lando",
      })._tag,
    ).toBe("Failure");
  });
});
