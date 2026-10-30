import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { Effect } from "effect";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

test.skipIf(process.platform === "win32").each([undefined, "caller-pwd", ""])(
  "BunSelfRunner uses native directory identity while preserving explicit PWD %j",
  async (pwd) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-self-context-"));
    let output = "";
    let calls = 0;
    try {
      await mkdir(join(root, "physical", "inside"), { recursive: true });
      await symlink("physical/inside", join(root, "link"));
      await writeFile(join(root, "marker"), "wrong");
      await writeFile(join(root, "physical", "marker"), "physical");
      const cwd = await realpath(join(root, "physical"));
      const argv = [
        "-e",
        'process.stdout.write(JSON.stringify([process.cwd(), process.env.PWD, await Bun.file("marker").text(), process.env.NPM_TOKEN, process.env.BUN_BE_BUN, process.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY])); process.exit(7)',
      ];
      // When
      const result = await Effect.runPromise(
        bunSelfRun({
          argv,
          cwd: `${root}/link/..`,
          env: { NPM_TOKEN: "registry-auth", ...(pwd === undefined ? {} : { PWD: pwd }) },
          spawner: {
            spawn: async (options) => {
              calls++;
              expect(options.cmd).toEqual([process.execPath, ...argv]);
              expect(options.cwd).toBe(cwd);
              const child = Bun.spawn([...options.cmd], {
                cwd: options.cwd,
                env: options.env,
                stdout: "pipe",
                stderr: "pipe",
              });
              output = await new Response(child.stdout).text();
              return { exitCode: await child.exited };
            },
          },
        }),
      );
      // Then
      expect(calls).toBe(1);
      expect(result.exitCode).toBe(7);
      expect(JSON.parse(output)).toEqual([cwd, pwd ?? cwd, "physical", "registry-auth", "1", "1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("BunSelfRunner rejects invalid cwd before invoking even a fake spawner", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-self-invalid-"));
  let spawned = false;
  try {
    // When
    const result = await Effect.runPromise(
      bunSelfRun({
        argv: ["--version"],
        cwd: join(root, "missing"),
        spawner: {
          spawn: async () => {
            spawned = true;
            return { exitCode: 0 };
          },
        },
      }).pipe(Effect.result),
    );
    // Then
    expect(spawned).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ _tag: "FileIoError", path: join(root, "missing") });
      expect(result.failure.remediation).toMatch(/directory/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller overrides cannot bypass the parent's BunSelfRunner reentry guard", async () => {
  // Given
  let spawned = false;
  // When
  const result = await withEnvVar("LANDO_DISALLOW_BUN_BE_BUN_REENTRY", "1", () =>
    Effect.runPromise(
      bunSelfRun({
        argv: ["--version"],
        env: { LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "0" },
        spawner: {
          spawn: async () => {
            spawned = true;
            return { exitCode: 0 };
          },
        },
      }).pipe(Effect.result),
    ),
  );
  // Then
  expect(spawned).toBe(false);
  expect(result._tag === "Failure" && result.failure._tag).toBe("NotImplementedError");
});

test.skipIf(process.platform === "win32")(
  "BunSelfRunner redacts spawn failures and disposes the acquired launcher",
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-self-error-"));
    let launcherPath = "";
    try {
      await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      // When
      const result = await Effect.runPromise(
        bunSelfRun({
          argv: ["--version"],
          env: { PATH: root, BUN_AUTH_TOKEN: "topsecret" },
          spawner: {
            spawn: async ({ env }) => {
              launcherPath = Bun.which("lando", { PATH: env.PATH ?? "" }) ?? "";
              throw Object.assign(new Error("spawn topsecret"), { code: "ENOENT" });
            },
          },
        }).pipe(Effect.provideService(RedactionService, makeRedactionService()), Effect.result),
      );
      // Then
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("FileIoError");
        expect(JSON.stringify(result.failure)).not.toContain("topsecret");
        expect(result.failure.remediation).toMatch(/executable/i);
      }
      expect(launcherPath).not.toBe("");
      await expect(access(dirname(launcherPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
