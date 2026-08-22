import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { PromptValidationError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { initApp } from "../../src/cli/commands/init.ts";
import { LandofileServiceLive } from "../../src/testing/engine-layers.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-option-parity-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverFrom = async (cwd: string) => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await Effect.runPromise(
      Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
        Effect.provide(LandofileServiceLive),
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
};

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, LANDO_USER_DATA_ROOT: join(cwd, "lando-data") },
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

describe("recipe option parity", () => {
  test("lamp --yes fills php, composer, webroot, and versioned mariadb defaults", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "lamp",
        nonInteractive: true,
        yes: true,
        answers: { name: "lamp-defaults" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const yaml = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(yaml).toContain("type: php:8.3");
      expect(yaml).not.toContain("via:");
      expect(yaml).toContain('composer: "2"');
      expect(yaml).toContain("webroot: /app");
      expect(yaml).toContain("type: mariadb:11.4");

      const landofile = await discoverFrom(result.directory);
      expect(landofile.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.3");
      expect(landofile.services?.[ServiceName.make("appserver")]?.composer).toBe("2");
      expect(String(landofile.services?.[ServiceName.make("appserver")]?.webroot ?? "")).toBe("/app");
      expect(landofile.services?.[ServiceName.make("database")]?.type).toBe("mariadb:11.4");
    });
  });

  test("lamp CLI --yes writes the same default Landofile", async () => {
    await withTempCwd(async (dir) => {
      const spawned = await runCli(
        ["init", "us576-lamp", "--recipe=lamp", "--yes", "--no-interactive", "--name=us576-lamp"],
        dir,
      );
      expect(spawned.exitCode).toBe(0);
      const yaml = await Bun.file(join(dir, "us576-lamp", ".lando.yml")).text();
      expect(yaml).toContain("type: php:8.3");
      expect(yaml).not.toContain("via:");
      expect(yaml).toContain('composer: "2"');
      expect(yaml).toContain("webroot: /app");
      expect(yaml).toContain("type: mariadb:11.4");
    });
  });

  test("drupal non-default answers emit nginx FPM, postgres 16, composer pin, and Drupal 10 scaffold", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "drupal",
        nonInteractive: true,
        answers: {
          name: "drupal-edge",
          php: "8.5",
          webserver: "nginx",
          database: "postgres:16",
          composer: "2.7.7",
          drupal: "10",
          webroot: "/app/web",
        },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const yaml = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(yaml).toContain("type: php:8.5");
      expect(yaml).toContain("via: fpm");
      expect(yaml).toContain("type: nginx");
      expect(yaml).toContain("backend: appserver");
      expect(yaml).not.toContain("allowOverride:");
      expect(yaml).toContain("type: postgres:16");
      expect(yaml).toContain('composer: "2.7.7"');
      expect(yaml).toContain("recommended-project:^10");

      const landofile = await discoverFrom(result.directory);
      expect(landofile.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.5");
      expect(landofile.services?.[ServiceName.make("appserver")]?.via).toBe("fpm");
      expect(landofile.services?.[ServiceName.make("edge")]?.type).toBe("nginx");
      expect(String(landofile.services?.[ServiceName.make("edge")]?.webroot ?? "")).toBe("/app/web");
      expect(landofile.services?.[ServiceName.make("database")]?.type).toBe("postgres:16");
    });
  });

  test("wordpress lemp and laravel still render their expected services", async () => {
    await withTempCwd(async (dir) => {
      const wordpress = await initApp({
        cwd: dir,
        full: false,
        recipe: "wordpress",
        nonInteractive: true,
        answers: { name: "wp-adjacent", php: "8.3", redis: "false" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const wordpressFile = await discoverFrom(wordpress.directory);
      expect(wordpressFile.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.3");
      expect(wordpressFile.services?.[ServiceName.make("database")]?.type).toBe("mariadb");
    });
    await withTempCwd(async (dir) => {
      const lemp = await initApp({
        cwd: dir,
        full: false,
        recipe: "lemp",
        nonInteractive: true,
        answers: { name: "lemp-adjacent", php: "8.3" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const lempFile = await discoverFrom(lemp.directory);
      expect(lempFile.services?.[ServiceName.make("web")]?.type).toBe("nginx");
      expect(lempFile.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.3");
      expect(lempFile.services?.[ServiceName.make("database")]?.type).toBe("mariadb");
    });
    await withTempCwd(async (dir) => {
      const laravel = await initApp({
        cwd: dir,
        full: false,
        recipe: "laravel",
        nonInteractive: true,
        answers: { name: "laravel-adjacent", php: "8.3", database: "postgres", worker: "true" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const laravelFile = await discoverFrom(laravel.directory);
      expect(laravelFile.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.3");
      expect(laravelFile.services?.[ServiceName.make("database")]?.type).toBe("postgres");
      expect(laravelFile.services?.[ServiceName.make("worker")]?.type).toBe("php:8.3");
    });
  });

  test("default drupal still serves /app/web with project-local Drush", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "drupal",
        nonInteractive: true,
        yes: true,
        answers: { name: "drupal-defaults" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const yaml = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(yaml).toContain("webroot: /app/web");
      expect(yaml).toContain("vendor/bin/drush");
      expect(yaml).toContain("allowOverride: true");
      expect(yaml).not.toContain("via:");
    });
  });

  test("drupal rejects composer false because scaffold needs Composer", async () => {
    await withTempCwd(async (dir) => {
      const promise = initApp({
        cwd: dir,
        full: false,
        recipe: "drupal",
        nonInteractive: true,
        answers: { name: "needs-composer", composer: "false" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      await expect(promise).rejects.toBeInstanceOf(PromptValidationError);
    });
  });

  test("relative webroot fails closed with PromptValidationError", async () => {
    await withTempCwd(async (dir) => {
      const promise = initApp({
        cwd: dir,
        full: false,
        recipe: "lamp",
        nonInteractive: true,
        answers: { name: "bad-webroot", webroot: "relative" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      await expect(promise).rejects.toBeInstanceOf(PromptValidationError);
    });
  });

  test("drupal-cms default still uses /app/web, project-local Drush, and the cms scaffold", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "drupal-cms",
        nonInteractive: true,
        yes: true,
        answers: { name: "cms-defaults" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const yaml = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(yaml).toContain("webroot: /app/web");
      expect(yaml).toContain("vendor/bin/drush");
      expect(yaml).toContain("drupal/cms");
      expect(yaml).not.toContain("recommended-project");
    });
  });

  test("composer false emits a boolean and drops composer tooling", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "lamp",
        nonInteractive: true,
        answers: { name: "no-composer", composer: "false" },
        postInitIO: { out: () => {}, err: () => {} },
      });
      const yaml = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(yaml).toMatch(/composer:\s+false\b/);
      expect(yaml).not.toMatch(/^ {2}composer:$/m);
      const landofile = await discoverFrom(result.directory);
      expect(landofile.services?.[ServiceName.make("appserver")]?.composer).toBe(false);
      expect(landofile.tooling?.composer).toBeUndefined();
    });
  });
});
