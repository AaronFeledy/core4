import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkMachineOutput } from "../../../scripts/check-machine-output.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-machine-output-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

const offenderStrings = (root: string, result: Awaited<ReturnType<typeof checkMachineOutput>>): string[] =>
  result.offenders.map(
    (offender) => `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.match}`,
  );

describe("machine-output boundary lint gate", () => {
  test("passes for event frames, renderer json lines, file writes, and specs with resultSchema", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/renderer/format.ts",
        'export const a = (e: { _tag: string }) => JSON.stringify({ _tag: "event", event: e._tag, payload: e });\nexport const b = (result: unknown) => JSON.stringify(result);\n',
      );
      await write(
        root,
        "core/src/cli/commands/state-write.ts",
        'import { writeFile } from "node:fs/promises";\nexport const save = async (path: string, state: unknown) => writeFile(path, `${JSON.stringify(state, null, 2)}\\n`);\n',
      );
      await write(
        root,
        "plugins/provider/src/http.ts",
        "export const body = (request: { body: unknown }) => JSON.stringify(request.body);\n",
      );
      await write(
        root,
        "core/src/cli/commands/error-message.ts",
        "export const msg = (tag: string) => `Invalid tag ${JSON.stringify(tag)}.`;\n",
      );
      await write(
        root,
        "core/src/cli/oclif/commands/app/info.ts",
        'import { Schema } from "effect";\nexport const spec = {\n  id: "app:info",\n  summary: "Show app info",\n  namespace: "app" as const,\n  bootstrap: "app" as const,\n  resultSchema: Schema.Struct({ name: Schema.String }),\n  run: (input: unknown) => input,\n};\n',
      );
      await write(
        root,
        "core/src/cli/result-encode.ts",
        "export const encode = (envelope: { apiVersion: string; command: string; ok: boolean; result: unknown }) => JSON.stringify(envelope);\n",
      );

      expect(await checkMachineOutput({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flags hand-rolled command-result envelopes and result stream frames", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/commands/inline-envelope.ts",
        'export const a = () => JSON.stringify({ apiVersion: "v4", command: "app:info", ok: true, result: { name: "x" }, warnings: [], deprecations: [] });\n',
      );
      await write(
        root,
        "core/src/cli/commands/inline-error-envelope.ts",
        'export const a = () => JSON.stringify({ apiVersion: "v4", command: "app:start", ok: false, error: { _tag: "X", message: "y" } });\n',
      );
      await write(
        root,
        "core/src/cli/commands/result-frame.ts",
        'export const a = (envelope: unknown) => JSON.stringify({ _tag: "result", envelope });\n',
      );
      await write(
        root,
        "core/src/cli/commands/aliased-envelope.ts",
        'export const a = () => {\n  const envelope = { apiVersion: "v4", command: "meta:doctor", ok: true, result: {}, warnings: [], deprecations: [] };\n  return JSON.stringify(envelope);\n};\n',
      );
      await write(
        root,
        "core/src/cli/commands/aliased-frame.ts",
        'export const a = (envelope: unknown) => {\n  const frame = { _tag: "result" as const, envelope };\n  return JSON.stringify(frame);\n};\n',
      );

      const result = await checkMachineOutput({ root });
      expect(result.ok).toBe(false);
      expect(offenderStrings(root, result)).toEqual([
        "core/src/cli/commands/aliased-envelope.ts:3:JSON.stringify(envelope)",
        "core/src/cli/commands/aliased-frame.ts:3:JSON.stringify(frame)",
        "core/src/cli/commands/inline-envelope.ts:1:JSON.stringify(<command-result-envelope>)",
        "core/src/cli/commands/inline-error-envelope.ts:1:JSON.stringify(<command-result-envelope>)",
        "core/src/cli/commands/result-frame.ts:1:JSON.stringify(<result-stream-frame>)",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flags command specs that do not declare a resultSchema", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/oclif/commands/app/by-shape.ts",
        'export const spec = {\n  id: "app:shape",\n  summary: "Shape spec",\n  namespace: "app" as const,\n  bootstrap: "app" as const,\n  run: (input: unknown) => input,\n};\n',
      );
      await write(
        root,
        "core/src/cli/oclif/commands/app/by-annotation.ts",
        'import type { LandoCommandSpec } from "../../command-base.ts";\nexport const spec: LandoCommandSpec = {\n  id: "app:annotated",\n  summary: "Annotated spec",\n  namespace: "app",\n  bootstrap: "app",\n  run: (input) => input,\n} as never;\n',
      );
      await write(
        root,
        "core/src/cli/oclif/commands/app/undefined-schema.ts",
        'export const spec = {\n  id: "app:undef",\n  summary: "Undefined schema",\n  namespace: "app" as const,\n  bootstrap: "app" as const,\n  resultSchema: undefined,\n  run: (input: unknown) => input,\n};\n',
      );

      const result = await checkMachineOutput({ root });
      expect(result.ok).toBe(false);
      expect(offenderStrings(root, result)).toEqual([
        "core/src/cli/oclif/commands/app/by-annotation.ts:2:app:annotated (missing resultSchema)",
        "core/src/cli/oclif/commands/app/by-shape.ts:1:app:shape (missing resultSchema)",
        "core/src/cli/oclif/commands/app/undefined-schema.ts:1:app:undef (missing resultSchema)",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
