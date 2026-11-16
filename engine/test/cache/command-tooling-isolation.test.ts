import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { compileInspectedAppCommands } from "../../src/cache/command-compiler.ts";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { loadLandofileLayers } from "../../src/services/landofile-live.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { app } from "./fixtures/command-index-codec.ts";

const redact = createRedactor("secrets").redactString;

test("uses real TypeScript and include sources for disabled commands without inventing issue origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-command-source-"));
  const file = join(root, ".lando.ts");
  const included = join(root, "tasks.yml");
  try {
    await writeFile(
      file,
      'export default { name: "sources", tooling: { off: false }, toolingIncludes: { extra: { file: "./tasks.yml", flatten: true } } };',
    );
    await writeFile(included, "tooling:\n  included: false\n");
    const loaded = await Effect.runPromise(
      loadLandofileLayers(root, file).pipe(Effect.provide(makeTestStateStore().layer)),
    );
    const entries = compileInspectedAppCommands({
      landofile: loaded.document,
      sourcePath: file,
      inspection: { scripts: [], problems: [], files: [] },
      redact,
    });
    expect(
      entries.map((entry) => ({
        id: entry.id,
        source: entry._tag === "Disabled" ? entry.source : undefined,
      })),
    ).toEqual([
      { id: "app:included", source: { path: included, task: "included" } },
      { id: "app:off", source: { path: file, task: "off" } },
    ]);
    const [unknown] = compileInspectedAppCommands({
      landofile: { tooling: { broken: { wrapper: true, flags: { value: {} } } } },
      sourcePath: file,
      inspection: { scripts: [], problems: [], files: [] },
      redact,
    });
    expect(unknown?.diagnostic).toMatchObject({ source: { path: file, task: "broken" } });
    const diagnostic = unknown?.diagnostic;
    if (diagnostic === undefined || !("issues" in diagnostic)) throw new Error("Missing diagnostic");
    expect(diagnostic.issues.map(({ source }) => source)).toEqual([undefined, undefined]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const compile = (task: ToolingTaskShape) =>
  compileInspectedAppCommands({
    landofile: rememberInternalToolingTasks({ tooling: { broken: task, healthy: { cmd: "echo healthy" } } }, [
      "broken",
    ]),
    inspection: { scripts: [], problems: [], files: [] },
    sourcePath: "command-tooling-isolation test",
    redact,
  });

test.each([
  { wrapper: true, cmds: ["one", "two"] },
  { flags: { first: { alias: "x" }, second: { alias: "x" } } },
])("isolates invalid normalization while preserving internal visibility (#2325) %#", (task) => {
  const entries = compile(task);
  expect(entries.map((entry) => entry.id)).toEqual(["app:broken", "app:healthy"]);
  expect(entries[0]).toMatchObject({
    visibility: "internal",
    _tag: "Unavailable",
    diagnostic: { _tag: "ToolingCompileError" },
  });
  expect(entries[0]).not.toHaveProperty("input");
  expect(entries[0]).not.toHaveProperty("wrapper");
  expect(entries[1]?.input).toBeDefined();
});

test("disabled tasks skip invalid normalization and retain refusal metadata (#2325)", () => {
  const [entry] = compile({
    disabled: true,
    wrapper: true,
    cmds: ["one", "two"],
    flags: { first: { alias: "x" }, second: { alias: "x" } },
  });
  expect(entry).toEqual({
    id: "app:broken",
    summary: "",
    visibility: "internal",
    sourceKind: "tooling",
    _tag: "Disabled",
    source: { path: "command-tooling-isolation test", task: "broken" },
  });
});

test("redacts normalization diagnostics before UTF-8 bounds (#2325)", () => {
  const secret = `credential-${"x".repeat(2000)}`;
  const multibyteKey = "\u754c".repeat(1000);
  const [entry] = compileInspectedAppCommands({
    landofile: {
      tooling: {
        broken: {
          cmd: "echo",
          flags: {
            [secret]: { required: true, default: "conflict" },
            [multibyteKey]: { required: true, default: "conflict" },
          },
        },
      },
    },
    inspection: { scripts: [], problems: [], files: [] },
    sourcePath: "command-tooling-isolation test",
    redact: createRedactor("secrets", { values: [secret] }).redactString,
  });
  expect(entry?.diagnostic?.message).toContain("[redacted]");
  expect(Buffer.byteLength(entry?.diagnostic?.message ?? "")).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(entry?.diagnostic?.remediation ?? "")).toBeLessThanOrEqual(1024);
  expect(entry?.diagnostic?.message).toContain("\u754c");
  expect(JSON.stringify(entry)).not.toContain(secret);
  expect(entry?.diagnostic?.message).not.toContain("\ufffd");
  expect(entry?.diagnostic?.remediation).not.toContain("\ufffd");
});

test("retains bounded structured issues, related sources and omitted counts through the cache", () => {
  const secret = "opaque-cache-credential";
  const entries = compileInspectedAppCommands({
    landofile: {
      tooling: {
        broken: {
          cmd: "echo",
          flags: Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [`${secret}-${index}`, { alias: "q" }]),
          ),
        },
      },
    },
    inspection: { scripts: [], problems: [], files: [] },
    sourcePath: "command-tooling-isolation test",
    toolingSource: () => ({
      path: `/app/${secret}/tasks.yml`,
      locate: (path) => ({ file: `/app/${secret}/tasks.yml`, layer: "local", path }),
    }),
    redact: createRedactor("secrets", { values: [secret] }).redactString,
  });
  const decoded = decodeAppCommandIndex(encodeAppCommandIndex({ ...app, entries }));
  const diagnostic = decoded?.entries[0]?.diagnostic;
  expect(diagnostic).toMatchObject({
    _tag: "ToolingCompileError",
    omittedIssueCount: 3,
    source: { path: "/app/[redacted]/tasks.yml", task: "broken" },
  });
  if (diagnostic === undefined || !("issues" in diagnostic)) throw new Error("Missing tooling diagnostic");
  expect(diagnostic.issues).toHaveLength(8);
  expect(diagnostic.issues[0]).toMatchObject({
    reason: "alias-collision",
    path: ["tooling", "broken", "flags", "[redacted]-1", "alias"],
    related: [
      {
        path: ["tooling", "broken", "flags", "[redacted]-0", "alias"],
        source: {
          file: "/app/[redacted]/tasks.yml",
          layer: "local",
          path: ["tooling", "broken", "flags", "[redacted]-0", "alias"],
        },
      },
    ],
  });
  expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(16 * 1024);
  expect(JSON.stringify(decoded)).not.toContain(secret);
});
