import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commandLauncher,
  createBunCommandEnv,
  inheritCommandEnv,
  launcherPathEnv,
} from "../../src/services/bun-command-env.ts";

test.each(["prepend", "append"] as const)(
  "composes Windows PATH case-insensitively with %s placement",
  (placement) => {
    // Given
    const env = { Path: "C:\\host", TOKEN: "kept" };
    // When
    const result = launcherPathEnv(env, "C:\\private", { platform: "win32", placement });
    // Then
    const keys = Object.keys(result).filter((key) => key.toUpperCase() === "PATH");
    expect(keys).toHaveLength(1);
    expect(result[keys[0] ?? ""]).toBe(
      placement === "prepend" ? "C:\\private;C:\\host" : "C:\\host;C:\\private",
    );
    expect(result.TOKEN).toBe("kept");
    expect(env.Path).toBe("C:\\host");
  },
);

test.each(["prepend", "append"] as const)(
  "an empty PATH gains only the launcher directory with %s placement",
  (placement) => {
    // Given: an empty PATH, where any separator would add the cwd as an entry.
    const env = { PATH: "" };
    // When
    const result = launcherPathEnv(env, "/private", { platform: "linux", placement });
    // Then
    expect(result.PATH).toBe("/private");
  },
);

test("caller Windows Path overrides the inherited PATH", () => {
  // Given
  const env = { Path: "C:\\caller" };
  // When
  const result = inheritCommandEnv(env, "win32");
  // Then
  const keys = Object.keys(result).filter((key) => key.toUpperCase() === "PATH");
  expect(keys).toHaveLength(1);
  expect(result[keys[0] ?? ""]).toBe("C:\\caller");
});

test("Windows bun launcher enables embedded Bun and preserves arguments", () => {
  // Given
  const target = "C:\\Program Files\\%lando%\\lando.exe";
  // When
  const launcher = commandLauncher("bun", target, "win32");
  // Then
  expect(launcher).toEqual({
    name: "bun.cmd",
    content:
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "BUN_BE_BUN=1"\r\n"C:\\Program Files\\%%lando%%\\lando.exe" %*\r\nexit /b %errorlevel%\r\n',
  });
});

test("standalone Lando fallback is scoped when PATH has no lando", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-fallback-env-"));
  let launcherPath = "";
  try {
    // When
    {
      await using launcher = await createBunCommandEnv(
        { command: "lando", env: { PATH: root }, cwd: root },
        { standalone: true, execPath: process.execPath, platform: process.platform },
      );
      launcherPath = Bun.which("lando", { PATH: launcher.env.PATH ?? "" }) ?? "";
      // Then
      expect(dirname(launcherPath)).not.toBe(root);
      expect(await Bun.file(launcherPath).text()).toContain(process.execPath);
    }
    expect(await access(dirname(launcherPath)).catch((cause: unknown) => cause)).toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source mode host Bun environment needs no launcher", async () => {
  // Given
  const env = { PATH: "/host/bin", BUN_BE_BUN: "1" };
  // When
  await using launcher = await createBunCommandEnv(
    { command: "bun", env },
    { standalone: false, execPath: process.execPath, platform: process.platform },
  );
  // Then
  expect(launcher.env).toEqual(env);
});
