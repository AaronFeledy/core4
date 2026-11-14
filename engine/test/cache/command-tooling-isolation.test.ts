import { expect, test } from "bun:test";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { compileInspectedAppCommands } from "../../src/cache/command-compiler.ts";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { app } from "./fixtures/command-index-codec.ts";

const redact = createRedactor("secrets").redactString;
const compile = (task: ToolingTaskShape) =>
  compileInspectedAppCommands({
    landofile: rememberInternalToolingTasks({ tooling: { broken: task, healthy: { cmd: "echo healthy" } } }, [
      "broken",
    ]),
    inspection: { scripts: [], problems: [], files: [] },
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
    source: { path: "<tooling>", task: "broken" },
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
