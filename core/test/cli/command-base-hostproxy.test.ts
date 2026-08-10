import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { isBuiltInCommandImplemented } from "../../src/cli/built-in-command-registry.ts";
import {
  EmptyResultSchema,
  type LandoCommandSpec,
  validateCommandSpec,
} from "../../src/cli/spec/command-base.ts";

describe("app:open command-base metadata", () => {
  test("app:open is a recognized implemented command id", () => {
    expect(isBuiltInCommandImplemented("app:open")).toBe(true);
  });

  test("a spec may declare hostProxyAllowed and still validate", () => {
    const spec: LandoCommandSpec = {
      id: "app:open",
      summary: "Open a resolved app URL.",
      namespace: "app",
      bootstrap: "app",
      hostProxyAllowed: true,
      resultSchema: EmptyResultSchema,
      run: () => Schema.decodeUnknown(EmptyResultSchema)({}) as never,
    };
    expect(() => validateCommandSpec(spec)).not.toThrow();
    expect(spec.hostProxyAllowed).toBe(true);
  });
});
