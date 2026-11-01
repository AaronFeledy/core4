import { describe, expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { ToolingInputDeclaration } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { decodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { abi6Bytes, app, encodedInput, entry } from "./fixtures/command-index-codec.ts";

for (const [magic, payload, decode] of [["LCAC", app, decodeAppCommandIndex]] as const) {
  describe(`${magic} canonical input policy`, () => {
    test("accepts SDK-encoded normalized boolean, string, and sensitive inputs", () => {
      // Given
      const declaration = Result.getOrThrow(
        normalizeToolingInput("probe", {
          flags: {
            force: { boolean: true, default: false },
            mode: { default: false, choices: ["false"] },
            privateMode: { sensitive: true },
            privateSwitch: { sensitive: true, boolean: true },
          },
          args: { count: { default: 2 }, target: { sensitive: true } },
        }),
      );
      const input = Schema.encodeSync(ToolingInputDeclaration)(declaration);
      const expected = { ...payload, entries: [{ ...entry, input: declaration }] };
      // When
      const cached = decode(abi6Bytes(magic, { ...payload, entries: [{ ...entry, input }] }));
      // Then
      expect(cached).toEqual(expected);
    });

    test.each([
      { boolean: true, default: "dev" },
      { boolean: false, default: false },
      { boolean: true, choices: [] },
      { boolean: true, choices: ["dev"] },
      { boolean: false, sensitive: true, default: "dev" },
      { boolean: true, sensitive: true, default: false },
      { boolean: false, sensitive: true, choices: [] },
      { boolean: true, sensitive: true, choices: ["dev"] },
    ])("agrees with SDK rejection of incompatible flag metadata %#", (patch) => {
      // Given: mutate real SDK-encoded metadata, removing unrelated defaults/choices.
      const input = {
        ...encodedInput,
        flags: encodedInput.flags.map(({ default: _, choices: __, ...flag }) => ({
          ...flag,
          sensitive: false,
          ...patch,
        })),
      };
      const bytes = abi6Bytes(magic, { ...payload, entries: [{ ...entry, input }] });
      // When
      const sdkResult = Schema.decodeUnknownResult(ToolingInputDeclaration)(input);
      const cached = decode(bytes);
      // Then
      expect(Result.isFailure(sdkResult)).toBe(true);
      expect(cached).toBeNull();
    });

    test.each([
      { order: -1 },
      { order: 0.5 },
      { sensitive: true, default: "dev" },
      { sensitive: true, choices: [] },
      { sensitive: true, choices: ["dev"] },
    ])("agrees with SDK rejection of incompatible positional metadata %#", (patch) => {
      // Given
      const input = {
        ...encodedInput,
        args: encodedInput.args.map(({ default: _, choices: __, ...arg }) => ({ ...arg, ...patch })),
      };
      const bytes = abi6Bytes(magic, { ...payload, entries: [{ ...entry, input }] });
      // When
      const sdkResult = Schema.decodeUnknownResult(ToolingInputDeclaration)(input);
      const cached = decode(bytes);
      // Then
      expect(Result.isFailure(sdkResult)).toBe(true);
      expect(cached).toBeNull();
    });
  });
}
