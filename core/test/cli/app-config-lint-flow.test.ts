import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

import { ConfigLintResult } from "@lando/sdk/schema";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

test.each([
  { style: "flow", endpoints: "[{_tag: internal, protocol: http, port: 80}]", valid: false },
  {
    style: "block",
    endpoints: "\n      - _tag: internal\n        protocol: http\n        port: 80",
    valid: true,
  },
])(
  "lint diagnoses $style endpoint mappings without a provider",
  async ({ endpoints, valid }) => {
    // Given
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-lint-flow-")));
    try {
      await writeFile(
        join(dir, ".lando.yml"),
        `name: flowtest\nservices:\n  web:\n    type: lando\n    image: nginx:1.27\n    home: false\n    endpoints: ${endpoints}\n`,
      );
      // When
      const proc = Bun.spawn({
        cmd: [process.execPath, cliEntry, "app:config:lint", "--format=json"],
        cwd: dir,
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: join(dir, "data"),
          LANDO_USER_CACHE_ROOT: join(dir, "cache"),
          LANDO_USER_CONF_ROOT: join(dir, "conf"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Then
      expect(exitCode, stderr).toBe(valid ? 0 : 1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(stdout));
      expect(envelope.result.valid).toBe(valid);
      if (valid) expect(envelope.result.violations).toEqual([]);
      else {
        expect(envelope.result.violations).toHaveLength(1);
        expect(envelope.result.violations[0]).toMatchObject({ path: [], line: 7, column: 17 });
        expect(envelope.result.violations[0]?.message).toMatch(/block/i);
        expect(envelope.result.violations[0]?.suggestion).toMatch(/block mapping/i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

const issue1834 =
  "name: demo\nservices:\n  web:\n    type: compose\n    image: alpine\n    configs:\n      []\n";

test.each([
  {
    style: "historical Bun next-line empty array",
    content: issue1834,
    valid: true,
    line: undefined,
    column: undefined,
  },
  {
    style: "next-line empty map",
    content: issue1834.replace("name: demo\n", "name: demo\nconfigs:\n  {}\n"),
    valid: true,
    line: undefined,
    column: undefined,
  },
  {
    style: "malformed next-line flow",
    content: issue1834.replace("[]", "[][]"),
    valid: false,
    line: 7,
    column: 7,
  },
  {
    style: "populated next-line flow mapping",
    content: issue1834.replace("[]", "{enabled: true}"),
    valid: false,
    line: 7,
    column: 7,
  },
])(
  "lint handles $style without a provider",
  async ({ content, valid, line, column }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-lint-next-flow-")));
    try {
      await writeFile(join(dir, ".lando.yml"), content);
      const proc = Bun.spawn({
        cmd: [process.execPath, cliEntry, "app:config:lint", "--format=json"],
        cwd: dir,
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: join(dir, "data"),
          LANDO_USER_CACHE_ROOT: join(dir, "cache"),
          LANDO_USER_CONF_ROOT: join(dir, "conf"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(valid ? 0 : 1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(stdout));
      expect(envelope.result.valid).toBe(valid);
      if (valid) expect(envelope.result.violations).toEqual([]);
      else {
        expect(envelope.result.violations).toHaveLength(1);
        expect(envelope.result.violations[0]).toMatchObject({ path: [], line, column });
        expect(envelope.result.violations[0]?.suggestion).toBeTruthy();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

test("lint presents a multiline rewrite in text and preserves its raw JSON suggestion", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-lint-rewrite-")));
  const suggestion = "Rewrite the flow mapping as a block mapping:\nx-demo:\n  a: 1";
  try {
    await writeFile(join(dir, ".lando.yml"), "name: demo\nx-demo:\n  {a: 1}\n");
    for (const mode of ["json", "plain", "lando"]) {
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          cliEntry,
          "app:config:lint",
          `--renderer=${mode === "json" ? "plain" : mode}`,
          `--format=${mode === "json" ? "json" : "text"}`,
        ],
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          NO_COLOR: "1",
          TERM: "dumb",
          LANDO_USER_DATA_ROOT: join(dir, "data"),
          LANDO_USER_CACHE_ROOT: join(dir, "cache"),
          LANDO_USER_CONF_ROOT: join(dir, "conf"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(dir, "plugins"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(1);
      if (mode === "json") {
        const envelope = Schema.decodeUnknownSync(
          Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
        )(JSON.parse(stdout));
        expect(envelope.result.valid).toBe(false);
        expect(envelope.result.violations).toHaveLength(1);
        expect(envelope.result.violations[0]).toMatchObject({
          rule: "landofile.load",
          line: 3,
          column: 3,
          message:
            "Inline objects are not supported in Landofiles at line 3. Use an indented block mapping instead.",
          suggestion,
        });
      } else {
        expect(stdout).toContain(
          "Inline objects are not supported in Landofiles at line 3. Use an indented block mapping instead.",
        );
        expect(stdout).toContain(
          "    fix: Rewrite the flow mapping as a block mapping:\n       | x-demo:\n       |   a: 1",
        );
        expect(stdout).not.toContain("\\u000a");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
