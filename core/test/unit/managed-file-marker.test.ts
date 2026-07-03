import { describe, expect, test } from "bun:test";

import type { FileFormat } from "@lando/sdk/schema";

import {
  commentPrefix,
  composeFileContent,
  hasFileMarker,
  stripFileMarker,
} from "../../src/managed-file/marker.ts";

describe("managed-file marker — commentPrefix", () => {
  test.each([
    ["javascript", "//"],
    ["typescript", "//"],
    ["ini", ";"],
    ["text", "#"],
    ["env", "#"],
    ["yaml", "#"],
    ["landofile", "#"],
    ["toml", "#"],
  ] as ReadonlyArray<readonly [FileFormat, string]>)(
    "%s uses the %p line-comment prefix",
    (format, prefix) => {
      expect(commentPrefix(format)).toBe(prefix);
    },
  );

  test("json has no line-comment prefix", () => {
    expect(commentPrefix("json")).toBeNull();
  });
});

describe("managed-file marker — javascript/typescript ownership round-trip", () => {
  test.each(["javascript", "typescript"] as ReadonlyArray<FileFormat>)(
    "%s composes a // marker line above the verbatim body",
    (format) => {
      const body = "export const alpha = 1;\n";
      const composed = composeFileContent(format, "r:app.code", body);

      expect(composed.startsWith("// lando-generated:r:app.code")).toBe(true);
      expect(composed.endsWith(body)).toBe(true);
      expect(hasFileMarker(format, composed, "r:app.code")).toBe(true);
    },
  );

  test.each(["javascript", "typescript"] as ReadonlyArray<FileFormat>)(
    "%s strips the // marker so the file adopts back to the raw body",
    (format) => {
      const body = "const value: number = 1;\n";
      const composed = composeFileContent(format, "r:app.code", body);
      const stripped = stripFileMarker(format, composed, "r:app.code");

      expect(hasFileMarker(format, stripped, "r:app.code")).toBe(false);
      expect(stripped).toBe(body);
    },
  );

  test("a code file gets a // marker, not the # that would corrupt the source", () => {
    const composed = composeFileContent("javascript", "r:server.js", "console.log('hi');\n");
    expect(composed.startsWith("//")).toBe(true);
    expect(composed.startsWith("#")).toBe(false);
  });
});
