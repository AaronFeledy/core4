import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect } from "effect";
import { runCli } from "../../src/cli/index.ts";
import { makeFixture, runSource } from "./subprocess-support";

test.each(["source", "include"] as const)(
  "repairs cached task availability when only the captured %s environment changes",
  async (location) => {
    const fixture = await makeFixture(`environment-${location}`);
    const task = `tooling:
  deploy:
    service: ":host"
    flags:
      target:
        choices: [dev, prod]
        default: "{{ env.TOOLING_CHOICE }}"
    cmd: echo deploying
`;
    const run = async (choice: string, argv: readonly string[]) => {
      const env = {
        ...fixture.env,
        TOOLING_CHOICE: choice,
        PRIVATE_CANARY: "environment-fingerprint-private-canary",
      };
      return runSource({ ...fixture, env }, [...argv, "--format=json"]);
    };
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        `name: environment-recovery\n${location === "include" ? "includes:\n  - ./tooling.yml\n" : task}`,
      );
      if (location === "include") await writeFile(join(fixture.root, "tooling.yml"), task);
      const refreshed = await run("bad", ["app:cache:refresh"]);
      expect(refreshed.exitCode, refreshed.stdout + refreshed.stderr).toBe(0);
      expect(JSON.parse(refreshed.stdout)).toMatchObject({
        warnings: [{ issues: [{ reason: "default-outside-choices" }] }],
      });

      const help = await run("dev", ["help", "deploy"]);
      expect(help.exitCode, help.stdout + help.stderr).toBe(0);
      expect(JSON.parse(help.stdout)).toMatchObject({
        ok: true,
        result: {
          target: { canonicalId: "app:deploy", input: { flags: [{ name: "target", default: "dev" }] } },
        },
      });
      const executed = await run("dev", ["deploy"]);
      expect(executed.exitCode, executed.stdout + executed.stderr).toBe(0);
      expect(JSON.parse(executed.stdout)).toMatchObject({
        ok: true,
        result: { stdout: "deploying --target=dev\n" },
      });

      const regressed = await run("bad", ["help", "deploy"]);
      expect(JSON.parse(regressed.stdout)).toMatchObject({
        ok: false,
        error: { _tag: "ToolingCompileError", issues: [{ reason: "default-outside-choices" }] },
      });
      const cache = await Bun.file(appToolingCompilationCachePath(fixture.cacheRoot, fixture.root)).bytes();
      expect(Buffer.from(cache).includes(Buffer.from("environment-fingerprint-private-canary"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test("in-process CLI rebuilds and writes against its captured environment", async () => {
  const fixture = await makeFixture("captured-environment");
  const env = { ...fixture.env, CAPTURED_ONLY: "new" };
  try {
    await writeFile(
      join(fixture.root, ".lando.yml"),
      'name: captured-environment\ntooling:\n  deploy:\n    service: ":host"\n    cmd: echo deploying\n',
    );
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: fixture.root,
        cacheRoot: fixture.cacheRoot,
        env: { ...env, CAPTURED_ONLY: "old" },
        landofile: { name: "captured-environment" },
        entries: [],
      }),
    );
    const io = createBufferedRendererIO();
    let exitCode = 0;

    await runCli({
      argv: ["help", "deploy", "--format=json"],
      rootUrl: "",
      context: {
        cwd: fixture.root,
        env,
        io,
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    });

    expect(exitCode, io.stdout() + io.stderr()).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({
      ok: true,
      result: { target: { canonicalId: "app:deploy" } },
    });
    expect(
      await Effect.runPromise(
        readAppCommandCacheForCwdDetailed({ cwd: fixture.root, cacheRoot: fixture.cacheRoot, env }),
      ),
    ).toMatchObject({ status: "fresh" });
  } finally {
    await fixture.cleanup();
  }
}, 30_000);
