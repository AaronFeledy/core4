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
      expect(exitCode, stderr).toBe(0);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(stdout));
      expect(envelope.result.valid).toBe(valid);
      if (valid) expect(envelope.result.violations).toEqual([]);
      else {
        expect(envelope.result.violations).toHaveLength(1);
        expect(envelope.result.violations[0]).toMatchObject({ path: "", line: 7, column: 17 });
        expect(envelope.result.violations[0]?.message).toMatch(/block/i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
