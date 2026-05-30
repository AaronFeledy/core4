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
  test("accepts Alpha 2 frontmatter and applies defaults", () => {
    const decoded = expectRight({
      id: "node-postgres",
      defaultLayer: "scenario",
      provider: "test",
      platforms: ["linux", "darwin"],
      tags: ["tutorial"],
      skip: { reason: "waiting for fixture", until: "2026-01-01" },
      deprecated: { since: "4.0.0", note: "Use the updated guide." },
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

  test.each(["axes", "variants"] as const)("rejects Beta-only `%s` with remediation", (key) => {
    const decoded = decode({ id: "node-postgres", [key]: [] });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(NotImplementedError);
    expect(decoded.left).toMatchObject({
      _tag: "NotImplementedError",
      commandId: "guide.frontmatter",
      specSection: "§19.16",
    });
    expect(decoded.left.message).toContain(key);
    expect(decoded.left.remediation).toContain("Phase 3 Beta");
    expect(decoded.left.remediation).toContain("§19.16");
    expect(decoded.left.remediation).toContain("spec/ROADMAP.md");
  });

  test("rejects e2e default layer with Beta remediation", () => {
    const decoded = decode({ id: "node-postgres", defaultLayer: "e2e" });
    expect(decoded._tag).toBe("Left");
    if (Either.isRight(decoded)) return;
    expect(decoded.left).toBeInstanceOf(NotImplementedError);
    expect(decoded.left).toMatchObject({
      _tag: "NotImplementedError",
      commandId: "guide.frontmatter",
      specSection: "§19.11",
    });
    expect(decoded.left.remediation).toContain("Phase 3 Beta");
    expect(decoded.left.remediation).toContain("§19.11");
  });
});
