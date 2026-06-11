import { Either, JSONSchema, Schema } from "effect";

import {
  DeprecationNotice,
  DeprecationSurfaceKind,
  DeprecationUse,
  getJsonSchema,
  structuralDeprecationKey,
} from "@lando/sdk/schema";

const decode = (input: unknown) => Schema.decodeUnknownEither(DeprecationNotice)(input);

describe("DeprecationNotice", () => {
  test("decodes a notice and applies the default severity", () => {
    const decoded = decode({
      since: "4.2.0",
      removeIn: "5.0.0",
      replacement: "new.surface",
      note: "Use the new surface.",
      docsUrl: "https://docs.lando.dev/deprecations/new-surface",
      ticket: "https://github.com/lando/core/issues/1234",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;
    expect(decoded.right.severity).toBe("warn");
    expect(structuralDeprecationKey(decoded.right)).toEqual({
      since: "4.2.0",
      removeIn: "5.0.0",
      note: "Use the new surface.",
    });
  });

  test("rejects invalid severity, semver, and docsUrl values", () => {
    expect(decode({ since: "4.2.0", severity: "fatal", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "next", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", note: "Use something else.", docsUrl: "not a url" })._tag).toBe("Left");
  });

  test("rejects patch, same-release, and past removeIn releases", () => {
    expect(decode({ since: "4.2.0", removeIn: "4.2.1", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", removeIn: "4.2.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", removeIn: "4.1.0", note: "Use something else." })._tag).toBe("Left");
  });

  test("requires removeIn for notices older than the active 4.x line", () => {
    expect(decode({ since: "3.21.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.0.0", note: "Use something else." })._tag).toBe("Left");
    expect(decode({ since: "4.2.0", note: "Use something else." })._tag).toBe("Right");
  });

  test("publishes JSON Schema through the registry", () => {
    expect(
      Object.getOwnPropertySymbols(DeprecationNotice.ast.annotations).map(
        (key) => DeprecationNotice.ast.annotations[key],
      ),
    ).toContain("Deprecation Notice");
    expect(JSON.stringify(JSONSchema.make(DeprecationNotice))).toContain("Deprecation Notice");
    expect(
      JSON.stringify((JSONSchema.make(DeprecationNotice) as { $defs?: Record<string, unknown> }).$defs),
    ).not.toContain('"$ref"');
    const jsonSchema = getJsonSchema("DeprecationNotice") as Record<string, unknown>;
    expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(JSON.stringify(jsonSchema)).toContain("Deprecation Notice");
  });
});

describe("DeprecationUse", () => {
  test("decodes a runtime deprecation use with timestamp metadata", () => {
    const decoded = Schema.decodeUnknownEither(DeprecationUse)({
      kind: "command",
      id: "app:start",
      notice: {
        since: "4.1.0",
        severity: "warn",
        note: "Use app:up instead.",
      },
      callsite: "start",
      app: "myapp",
      plugin: "@lando/core",
      timestamp: "2026-06-11T16:00:00.000Z",
    });

    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.kind).toBe("command");
      expect(decoded.right.id).toBe("app:start");
    }
  });

  test("rejects unknown deprecation surface kinds", () => {
    const decoded = Schema.decodeUnknownEither(DeprecationSurfaceKind)("not-a-surface");

    expect(decoded._tag).toBe("Left");
  });
});
