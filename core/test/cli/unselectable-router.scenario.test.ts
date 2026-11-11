import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");

interface Case {
  readonly argv: ReadonlyArray<string>;
  readonly command: string;
  readonly exit?: number;
  /** The command reports why no router is selectable as its own error, or as a doctor finding. */
  readonly reportsReason?: boolean;
  readonly error?: string;
}

const cases: ReadonlyArray<Case> = [
  { argv: ["info"], command: "app:info" },
  { argv: ["stop"], command: "app:stop" },
  { argv: ["destroy", "--yes"], command: "app:destroy", exit: 0 },
  { argv: ["logs"], command: "app:logs" },
  { argv: ["exec", "web", "--", "true"], command: "app:exec" },
  // A routed start refuses before it prepares the runtime, builds, or runs hooks.
  { argv: ["start"], command: "app:start", exit: 1, reportsReason: true, error: "ProxySetupError" },
  { argv: ["doctor"], command: "meta:doctor", reportsReason: true },
  { argv: ["poweroff"], command: "apps:poweroff", exit: 0 },
];

for (const { argv, command, exit: expectedExit, reportsReason, error } of cases) {
  test(`#2138 ${argv[0]} reaches its operation when the configured router is not installed`, async () => {
    // Given: a routed app in isolated roots whose global config names a router no plugin provides.
    const root = await mkdtemp(join(tmpdir(), "lando-unselectable-router-"));
    try {
      const app = join(root, "app");
      const conf = join(root, "conf");
      await mkdir(app);
      await mkdir(conf);
      await writeFile(join(app, ".lando.yml"), "name: repro\nservices:\n  web:\n    type: nginx\n");
      await writeFile(join(conf, "config.yml"), "defaultRouterService: missing\n");

      // When
      const proc = Bun.spawn([process.execPath, cliEntry, "--format=json", ...argv], {
        cwd: app,
        env: {
          ...process.env,
          LANDO_USER_CONF_ROOT: conf,
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      // Then: runtime bootstrap no longer fails on router selection. With no runtime installed in
      // these roots, commands that need one still report that; destroy has nothing to remove.
      const result = stdout
        .split("\n")
        .flatMap((line) => (line.startsWith("{") ? [JSON.parse(line)] : []))
        .map((line) => (line._tag === "result" ? line.envelope : line))
        .find((envelope) => envelope.apiVersion === "v4");
      expect(result?.command).toBe(command);
      expect(stdout).not.toContain("LandoRuntimeBootstrapError");
      expect(/"(?:proxyId|routerId)"\s*:\s*"missing"/.test(stdout)).toBe(reportsReason === true);
      if (error !== undefined) expect(result?.error).toMatchObject({ _tag: error, proxyId: "missing" });
      if (expectedExit !== undefined) expect(exit).toBe(expectedExit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
