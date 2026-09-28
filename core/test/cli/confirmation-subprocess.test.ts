import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");

for (const command of ["rebuild", "destroy", "app:rebuild", "app:destroy"]) {
  test(`${command} rejects a non-interactive host-proxy child before app discovery`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-confirmation-"));
    try {
      // When
      const child = Bun.spawn([process.execPath, cli, command, "--format=json"], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_TELEMETRY: "false",
          LANDO_HOST_PROXY_DEPTH: "1",
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      // Then
      const frames = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const last = frames.at(-1);
      expect(last?.envelope ?? last).toMatchObject({
        ok: false,
        error: {
          _tag: "CommandConfirmationError",
          reason: "non-interactive",
          message: expect.any(String),
          remediation: expect.stringContaining("--yes"),
        },
      });
      expect(code).toBe(1);
      expect(stderr).not.toContain("LandofileNotFoundError");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
