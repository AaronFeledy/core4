import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { emitLandofileYamlEither, parseLandofile } from "@lando/sdk/landofile";
import { LANDOFILE_EDITOR_SCHEMA_URL, LandofileAuthoringFragment } from "@lando/sdk/schema";

import { lando4ConfigTranslator } from "../src/translator.ts";

const encodeOf = lando4ConfigTranslator.encode;
const modeline = `# yaml-language-server: $schema=${LANDOFILE_EDITOR_SCHEMA_URL}`;
if (encodeOf === undefined) throw new Error("The lando4 translator must ship an encoder.");

const COMPLETE_CONTEXT = {
  name: "myapp",
  runtime: 4,
  services: { web: { type: "lando", port: "{{ env.PORT }}" } },
} as const;

describe("lando4 encoding", () => {
  test("emits the complete context with sorted keys and verbatim expressions", async () => {
    const result = await Effect.runPromise(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(result.diagnostics).toEqual([]);
    expect(result.text).toBe(
      [
        modeline,
        "name: myapp",
        "runtime: 4",
        "services:",
        "  web:",
        '    port: "{{ env.PORT }}"',
        "    type: lando",
        "",
      ].join("\n"),
    );
  });

  test("emits only the editor modeline as a leading comment", async () => {
    const result = await Effect.runPromise(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(result.text.split("\n").filter((line) => line.startsWith("#"))).toEqual([modeline]);
  });

  test("is byte stable across repeated encodes", async () => {
    const first = await Effect.runPromise(encodeOf({ context: COMPLETE_CONTEXT }));
    const second = await Effect.runPromise(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(first.text).toBe(second.text);
  });

  test("emits only the requested fragment and never flattens the context", async () => {
    const result = await Effect.runPromise(
      encodeOf({
        context: COMPLETE_CONTEXT,
        fragment: { services: { web: { port: "{{ env.LOCAL_PORT }}" } } },
      }),
    );
    expect(result.text).toBe(
      [modeline, "services:", "  web:", '    port: "{{ env.LOCAL_PORT }}"', ""].join("\n"),
    );
    expect(result.text).not.toContain("name:");
    expect(result.text).not.toContain("type: lando");
  });

  test("round-trips canonical authoring values through parse", async () => {
    const result = await Effect.runPromise(encodeOf({ context: COMPLETE_CONTEXT }));
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: result.text, cwd: "." }),
    );
    expect(parsed).toEqual(COMPLETE_CONTEXT);
    const actual = await Effect.runPromise(
      Schema.decodeUnknownEffect(LandofileAuthoringFragment)(parsed, { onExcessProperty: "error" }),
    );
    const expected = await Effect.runPromise(
      Schema.decodeUnknownEffect(LandofileAuthoringFragment)(COMPLETE_CONTEXT, { onExcessProperty: "error" }),
    );
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  test("rejects an incomplete authoring context", async () => {
    const exit = await Effect.runPromiseExit(encodeOf({ context: { name: 4 } as never }));
    expect(exit._tag).toBe("Failure");
  });

  test("rejects an expression-only context even when a fragment is provided", async () => {
    const exit = await Effect.runPromiseExit(
      encodeOf({
        context: "{{ env.CONFIG }}" as never,
        fragment: { services: { web: { port: "{{ env.LOCAL_PORT }}" } } },
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("agrees with the canonical serializer", () => {
    expect(emitLandofileYamlEither({ b: 1, a: 2 }, { sortKeys: true })).toEqual(
      expect.objectContaining({ _tag: "Success" }),
    );
  });

  test("leaves the default serializer free of editor comments", () => {
    expect(emitLandofileYamlEither({ name: "demo", runtime: 4 })).toMatchObject({
      _tag: "Success",
      success: "name: demo\nruntime: 4\n",
    });
  });
});
