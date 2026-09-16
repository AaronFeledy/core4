import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { Effect } from "effect";

import { TestLandofileServiceLive } from "../_support/landofile-layer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-drupal-recipe-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("lando init — Drupal recipe", () => {
  test("renders the scaffold workflow through the native dispatcher", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appDir = join(dir, "drupal-app");

      // When
      const result = await run(
        [
          process.execPath,
          cliEntry,
          "init",
          "drupal-app",
          "--recipe=drupal",
          "--no-interactive",
          "--answer=name=drupal-app",
          "--answer=php=8.3",
          "--answer=database=mariadb:11.4",
        ],
        dir,
        { LANDO_USER_DATA_ROOT: join(dir, "lando-data") },
      );

      // Then
      expect(result.exitCode).toBe(0);
      const landofile = await Bun.file(join(appDir, ".lando.yml")).text();
      expect(landofile).toContain("webroot: /app/web");
      expect(landofile).toContain("allowOverride: true");
      expect(landofile).toContain("vendor/bin/drush");
      expect(landofile).toContain("drupal-scaffold:");
      expect(landofile).toContain("arguments: false");
      const previousCwd = process.cwd();
      try {
        process.chdir(appDir);
        const loaded = await Effect.runPromise(
          Effect.flatMap(LandofileService, (service) => service.discover).pipe(
            Effect.provide(TestLandofileServiceLive),
          ),
        );
        // App identity and proxy domain are bound later by the planner, not init.
        expect(loaded.name).toBe("drupal-app");
        expect(loaded.services?.[ServiceName.make("appserver")]?.routes).toEqual([
          { hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" },
        ]);
      } finally {
        process.chdir(previousCwd);
      }
      expect(landofile).toContain('hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"');
    });
  });
});
