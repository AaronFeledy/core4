import { expect, test } from "bun:test";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { compileInspectedAppCommands } from "../../src/cache/command-compiler.ts";

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
  expect(entries[0]).toMatchObject({ hidden: true, loadError: { _tag: "ToolingCompileError" } });
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
  expect(entry).toEqual({ id: "app:broken", summary: "", hidden: true, disabled: true });
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
  expect(entry?.loadError?.message).toContain("[redacted]");
  expect(entry?.loadError?.remediation).toContain("[redacted]");
  expect(Buffer.byteLength(entry?.loadError?.message ?? "")).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(entry?.loadError?.remediation ?? "")).toBeLessThanOrEqual(1024);
  expect(entry?.loadError?.message).toContain("\u754c");
  expect(entry?.loadError?.remediation).toContain("\u754c");
  expect(entry?.loadError?.message).not.toContain("\ufffd");
  expect(entry?.loadError?.remediation).not.toContain("\ufffd");
});
