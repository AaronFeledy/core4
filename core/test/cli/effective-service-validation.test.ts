import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigLintResult } from "@lando/sdk/schema";
import { Schema } from "effect";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

test.each([
  { service: "type: minio\n    consolePort: 19001", path: ["services", "web", "image"] },
  {
    service: "type: minio\n    image: example.test/minio:fixture\n    consolePort: 9000",
    path: ["services", "web", "port"],
  },
  {
    service: "type: mailpit\n    environment:\n      MP_UI_BIND_ADDR: 127.0.0.1:8025",
    path: ["services", "web", "environment", "MP_UI_BIND_ADDR"],
  },
])(
  "CLI lint preserves effective service findings at $path",
  async ({ service, path }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-cli-effective-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: effective-validation\nservices:\n  web:\n    ${service}\n    endpoints: []\n`,
      );
      // When
      const child = Bun.spawn({
        cmd: [process.execPath, cliEntry, "app:config:lint", "--format=json"],
        cwd: root,
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then
      expect(exitCode, stderr).toBe(1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(stdout));
      expect(envelope.result.valid).toBe(false);
      expect(envelope.result.violations).toEqual([
        expect.objectContaining({
          path,
          suggestion: expect.any(String),
          source: expect.objectContaining({ file: join(root, ".lando.yml") }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
