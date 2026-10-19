import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { appCertificateFiles } from "@lando/proxy-traefik";
import { AppId } from "@lando/sdk/schema";
import { liveEnabled } from "./scanner-live-fixture";

// Uses the inherited managed runtime and global router, like the other CLI-driven live
// tests. The fault lives only at this app's own certificate path, so other apps are untouched.
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const commandTimeout = 120_000;

const lando = async (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  // A compiled runner may be acting as Bun through BUN_BE_BUN; the CLI under test must not inherit it.
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const proc = Bun.spawn([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], {
    cwd,
    env: { ...(binary === undefined ? process.env : inherited), LANDO_TELEMETRY_ENABLED: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: commandTimeout,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

test.skipIf(!liveEnabled)(
  "a route apply failure whose rollback also fails renders both failures with their roles",
  async () => {
    // Given: a routed app whose certificate path is replaced by a directory holding an
    // undeletable file. Writing the refreshed certificate fails, and so does the rollback
    // that removes the app's routes and certificates.
    const appRoot = await mkdtemp(join(tmpdir(), "lando-compensation-live-"));
    const name = `compensation-${crypto.randomUUID().slice(0, 8)}`;
    const certificate = appCertificateFiles(makeLandoPaths(), AppId.make(name)).cert;
    const pinned = join(certificate, "pinned");
    const landofile = (hostnames: readonly string[]) =>
      `name: ${name}\nservices:\n  web:\n    type: nginx\n    routes:\n${hostnames.map((hostname) => `      - hostname: ${hostname}\n`).join("")}`;
    let faulted = false;
    try {
      await Bun.write(join(appRoot, ".lando.yml"), landofile([`${name}.lndo.site`]));
      const started = await lando(appRoot, ["start", "--format=json"]);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      await rm(certificate, { force: true });
      await mkdir(pinned, { recursive: true });
      faulted = true;
      await writeFile(join(pinned, "file"), "pinned");
      await chmod(pinned, 0o500);
      await Bun.write(
        join(appRoot, ".lando.yml"),
        landofile([`${name}.lndo.site`, `second-${name}.lndo.site`]),
      );

      // When: the app starts again, once for each output surface.
      const json = await lando(appRoot, ["start", "--format=json"]);
      const text = await lando(appRoot, ["start", "--renderer=plain"]);

      // Then: the route failure is primary and the route-removal failure is its rollback.
      expect(json.exitCode, json.stdout + json.stderr).toBe(1);
      // start streams frames under --format=json; the envelope is in the terminal result frame.
      const resultFrame = json.stdout.split("\n").find((line) => line.startsWith('{"_tag":"result"'));
      expect(resultFrame, json.stdout).toBeDefined();
      expect(JSON.parse(resultFrame ?? "{}").envelope).toMatchObject({
        ok: false,
        error: { _tag: "ProxyApplyError", additionalErrors: [{ _tag: "ProxyError", role: "rollback" }] },
      });
      expect(text.exitCode).toBe(1);
      expect(text.stderr).toContain("Rollback also failed (ProxyError)");
      expect(text.stderr).toContain("code: ProxyApplyError");
      expect(text.stderr).not.toMatch(/^ {4}at /mu);
      expect(text.stderr).not.toContain("code: Error");
    } finally {
      if (faulted) {
        await chmod(pinned, 0o700);
        await rm(certificate, { recursive: true, force: true });
      }
      const destroyed = await lando(appRoot, ["destroy", "--yes", "--format=json"]);
      await rm(appRoot, { recursive: true, force: true });
      expect(destroyed.exitCode, destroyed.stdout + destroyed.stderr).toBe(0);
    }
  },
  600_000,
);
