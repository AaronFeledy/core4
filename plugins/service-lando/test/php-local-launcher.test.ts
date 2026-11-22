import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { php84ServiceType } from "../src/services/php.ts";
import { phpLocalLauncher } from "../src/services/php-local-launcher.ts";

test.each([
  { via: "apache" },
  { via: "fpm" },
  { via: "cli" },
  { via: "cli", image: "custom-php:latest", composer: false },
] as const)("PHP resolution declares both task launchers for %p", async (config) => {
  const name = ServiceName.make("web");
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-launchers",
    services: { web: { type: "php:8.4", ...config } },
  });
  const service = landofile.services?.[name];
  if (service === undefined) throw new TypeError("Expected a PHP service");
  const resolution = await Effect.runPromise(
    php84ServiceType.resolve({
      name,
      service,
      appRoot: "/srv/apps/php-launchers",
      metadata: {
        source: "/srv/apps/php-launchers/.lando.yml",
        runtime: 4,
        resolvedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  expect(Object.keys(resolution.launchers ?? {}).sort()).toEqual([":drupal-local", ":php-local"]);
});

const runLocal = async (input: {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly appRoot?: string;
  readonly files?: Readonly<Record<string, number>>;
}) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lando php-local-"));
  try {
    const cwd = join(root, input.cwd ?? "app/module/src");
    const path = join(root, "bin");
    await mkdir(cwd, { recursive: true });
    await mkdir(path);
    const stub = '#!/bin/sh\nprintf "%s\\n" "$0" "$PWD" "$PATH" "$@"\nexit 23\n';
    for (const [relative, mode] of Object.entries({ "bin/php": 0o755, ...input.files })) {
      const file = join(root, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, stub, { mode });
    }
    const command = input.command?.startsWith("/") ? join(root, input.command) : input.command;
    const argv = command === undefined ? [] : [command, ...(input.args ?? [])];
    const result = Bun.spawnSync(["/bin/sh", ...phpLocalLauncher.slice(1), ...argv], {
      cwd,
      env: {
        PATH: path,
        PWD: cwd,
        LANDO_APP_ROOT: input.appRoot === "" ? undefined : join(root, input.appRoot ?? "app"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      },
      invoked: (binary: string, args: readonly string[]) => ({
        stdout: [join(root, binary), cwd, path, ...args, ""].join("\n"),
        stderr: "",
        exitCode: 23,
      }),
      root,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

(process.platform === "win32" ? describe.skip : describe)("PHP local launcher", () => {
  test("executes the nearest vendor binary without changing cwd, PATH, argv, or status", async () => {
    const args = ["", "a b", "*", "$(not a command)"];
    const { result, invoked } = await runLocal({
      command: "phpunit",
      args,
      files: {
        "app/vendor/bin/phpunit": 0o755,
        "app/module/vendor/bin/phpunit": 0o755,
        "app/module/phpunit": 0o644,
      },
    });
    expect(result).toEqual(invoked("app/module/vendor/bin/phpunit", args));
  });

  test.each(["artisan", "bin/console", "cli/joomla.php"])(
    "runs the project script %s through PHP",
    async (command) => {
      const { result, invoked, root } = await runLocal({
        command,
        args: ["a b"],
        files: { [`app/${command}`]: 0o644 },
      });
      expect(result).toEqual(invoked("bin/php", [join(root, "app", command), "a b"]));
    },
  );

  test("executes absolute commands directly", async () => {
    const { result, invoked } = await runLocal({
      command: "/bin/tool",
      files: { "bin/tool": 0o755 },
      args: ["--flag"],
    });
    expect(result).toEqual(invoked("bin/tool", ["--flag"]));
  });

  test("falls back to PATH past a non-executable vendor file", async () => {
    const { result, invoked } = await runLocal({
      command: "tool",
      files: { "bin/tool": 0o755, "app/vendor/bin/tool": 0o644 },
    });
    expect(result).toEqual(invoked("bin/tool", []));
  });

  test("starts at the app root when cwd is outside it", async () => {
    const { result, invoked } = await runLocal({
      cwd: "app-other/subdir",
      command: "tool",
      files: { "app/vendor/bin/tool": 0o755, "app-other/vendor/bin/tool": 0o755 },
    });
    expect(result).toEqual(invoked("app/vendor/bin/tool", []));
  });

  test("searches ancestors with no app root set", async () => {
    const { result, invoked } = await runLocal({
      appRoot: "",
      command: "tool",
      files: { "vendor/bin/tool": 0o755 },
    });
    expect(result).toEqual(invoked("vendor/bin/tool", []));
  });

  test("stops at the app root and reports a missing command", async () => {
    const { result } = await runLocal({ command: "tool", files: { "vendor/bin/tool": 0o755 } });
    expect(result).toEqual({
      stdout: "",
      stderr: "php-local: tool is not in vendor/bin or the app, or on PATH.\n",
      exitCode: 127,
    });
  });

  test("rejects a missing command token", async () => {
    const { result } = await runLocal({});
    expect(result).toEqual({ stdout: "", stderr: "php-local: a command is required.\n", exitCode: 1 });
  });
});
