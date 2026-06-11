import { describe, expect, test } from "bun:test";

import { GuideFrontmatter as CoreGuideFrontmatter } from "@lando/core/schema";
import { GuideFrontmatter, decodeGuideFrontmatterEither } from "@lando/sdk/docs/components";
import { NotImplementedError } from "@lando/sdk/errors";
import { Either, JSONSchema, ParseResult, Schema } from "effect";

const decode = (input: unknown) => decodeGuideFrontmatterEither(input);

const expectRight = (input: unknown): GuideFrontmatter => {
  const decoded = decode(input);
  expect(decoded._tag).toBe("Right");
  if (Either.isLeft(decoded)) throw decoded.left;
  return decoded.right;
};

describe("GuideFrontmatter", () => {
  test("accepts frontmatter and applies defaults", () => {
    const decoded = expectRight({
      id: "node-postgres",
      defaultLayer: "scenario",
      provider: "test",
      platforms: ["linux", "darwin"],
      tags: ["tutorial"],
      skip: { reason: "waiting for fixture", until: "2026-01-01" },
      deprecated: { since: "4.0.0", removeIn: "5.0.0", note: "Use the updated guide." },
    });

    expect(decoded.timeout).toBe(60000);
    expect(decoded.deprecated?.severity).toBe("warn");
    expect(Schema.encodeSync(GuideFrontmatter)(decoded)).toMatchObject({ id: "node-postgres" });
    expect(Schema.decodeUnknownSync(CoreGuideFrontmatter)(decoded)).toEqual(decoded);
    expect(JSONSchema.make(GuideFrontmatter)).toMatchObject({
      $defs: { GuideFrontmatter: { title: "Guide Frontmatter" } },
    });
  });

  test("rejects non-kebab-case ids", () => {
    const decoded = decode({ id: "NodePostgres" });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(ParseResult.ParseError);
    expect(decoded.left.message).toContain("lowercase kebab-case");
  });

  test("accepts single-axis `tabs:` value declarations", () => {
    const decoded = expectRight({ id: "node-postgres", tabs: ["linux", "macos"] });
    expect(decoded.tabs).toEqual(["linux", "macos"]);
    expect(Schema.decodeUnknownSync(CoreGuideFrontmatter)(decoded)).toEqual(decoded);
  });

  test("rejects empty, duplicate, or non-kebab `tabs:` values", () => {
    expect(decode({ id: "node-postgres", tabs: [] })._tag).toBe("Left");
    expect(decode({ id: "node-postgres", tabs: ["linux", "linux"] })._tag).toBe("Left");
    expect(decode({ id: "node-postgres", tabs: ["Linux"] })._tag).toBe("Left");
  });

  test("accepts multi-axis `axes:` declarations", () => {
    const decoded = expectRight({
      id: "node-postgres",
      axes: { os: ["linux", "macos"], "package-manager": ["composer", "npm"] },
    });
    expect(decoded.axes).toEqual({ os: ["linux", "macos"], "package-manager": ["composer", "npm"] });
    expect(Schema.decodeUnknownSync(CoreGuideFrontmatter)(decoded)).toEqual(decoded);
  });

  test("accepts per-cell `variants:` overrides keyed by dot-joined axis values", () => {
    const decoded = expectRight({
      id: "node-postgres",
      axes: { os: ["linux", "macos"], "package-manager": ["composer", "npm"] },
      variants: {
        "linux.npm": { skip: { reason: "npm unsupported on linux here" } },
        "macos.composer": { tags: ["slow"], platforms: ["darwin"] },
      },
    });
    expect(decoded.variants?.["linux.npm"]?.skip?.reason).toBe("npm unsupported on linux here");
    expect(decoded.variants?.["macos.composer"]?.tags).toEqual(["slow"]);
  });

  test("accepts single-axis `tabs:` with `variants:` overrides", () => {
    const decoded = expectRight({
      id: "node-postgres",
      tabs: ["linux", "macos"],
      variants: { linux: { tags: ["ci"] } },
    });
    expect(decoded.variants?.linux?.tags).toEqual(["ci"]);
  });

  test("rejects `tabs:` and `axes:` declared together", () => {
    const decoded = decode({ id: "node-postgres", tabs: ["linux"], axes: { os: ["linux"] } });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(ParseResult.ParseError);
    expect(decoded.left.message).toContain("mutually exclusive");
  });

  test("rejects `variants:` keys that are not Cartesian cells", () => {
    const decoded = decode({
      id: "node-postgres",
      axes: { os: ["linux", "macos"] },
      variants: { windows: { tags: ["x"] } },
    });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(ParseResult.ParseError);
    expect(decoded.left.message).toContain("Cartesian");
  });

  test("rejects empty `axes:` and empty axis value lists", () => {
    expect(decode({ id: "node-postgres", axes: {} })._tag).toBe("Left");
    expect(decode({ id: "node-postgres", axes: { os: [] } })._tag).toBe("Left");
    expect(decode({ id: "node-postgres", axes: { os: ["linux", "linux"] } })._tag).toBe("Left");
    expect(decode({ id: "node-postgres", axes: { OS: ["linux"] } })._tag).toBe("Left");
  });

  test("rejects e2e default layer with remediation", () => {
    const decoded = decode({ id: "node-postgres", defaultLayer: "e2e" });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(NotImplementedError);
    expect(decoded.left).toMatchObject({
      _tag: "NotImplementedError",
      commandId: "guide.frontmatter",
    });
    expect(decoded.left.remediation).toContain("not supported yet");
  });
});
