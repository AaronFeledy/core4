import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { makeFixture, runProcess, runSource } from "./subprocess-support";

test.each(["plain", "lando", "json"])(
  "rebuilds a missing index without refresh output with the %s renderer",
  async (renderer) => {
    const fixture = await makeFixture(`missing-${renderer}`);
    try {
      await mkdir(join(fixture.root, ".lando/scripts"), { recursive: true });
      await writeFile(
        join(fixture.root, ".lando/scripts/probe.bun.sh"),
        "# ---\n# desc: Check the cache\n# ---\necho cache-healed\n",
      );

      const result = await runSource(fixture, ["probe", `--renderer=${renderer}`]);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      if (renderer === "json") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          result: { stdout: "cache-healed\n", stderr: "", exitCode: 0 },
        });
        expect(result.stderr).toBe("");
      } else {
        expect(result.stdout).toBe("cache-healed\n");
        expect(result.stderr.trim().split("\n")).toEqual([
          expect.stringContaining("app:probe (1 step)"),
          expect.stringContaining("[tooling:app:probe:exec] start: executing"),
          expect.stringMatching(/\[tooling:app:probe:exec\] .* complete/u),
          expect.stringMatching(/complete \(1 .* 0 /u),
        ]);
      }
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each([{ argv: ["probe", "--help"] }, { argv: ["help", "probe"] }])(
  "rebuilds missing metadata before tooling help with $argv",
  async ({ argv }) => {
    const fixture = await makeFixture("missing-help");
    try {
      await mkdir(join(fixture.root, ".lando/scripts"), { recursive: true });
      await writeFile(
        join(fixture.root, ".lando/scripts/probe.bun.sh"),
        "# ---\n# desc: Check the cache\n# arguments: false\n# ---\necho ran > executed\n",
      );

      const result = await runSource(fixture, [...argv, "--format=json"]);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "cli:help",
        result: { target: { canonicalId: "app:probe", source: "tooling" } },
      });
      expect(result.stderr).toBe("");
      expect(await Bun.file(join(fixture.root, "executed")).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test("an unknown command uses fresh-index remediation after rebuilding missing metadata", async () => {
  const fixture = await makeFixture("missing-unknown");
  try {
    const result = await runSource(fixture, ["absent", "--format=json"]);

    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "ToolingCommandUnavailableError", reason: "unknown-command", commandId: "app:absent" },
    });
    expect(result.stderr).toBe("");
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("host-proxy tooling stays denied without rebuilding a missing index", async () => {
  const fixture = await makeFixture("missing-proxy");
  try {
    const dispatcher = resolve(import.meta.dirname, "../../src/cli/run.ts");
    const call = {
      operation: "runLando",
      app: { name: "router-missing-proxy", root: fixture.root },
      mount: { containerRoot: "/app", hostRoot: fixture.root },
      cwd: "/app",
      callId: "missing-index",
      depth: 0,
      callerService: "web",
      argv: ["probe", "--format=json"],
      env: {},
    };
    const result = await runProcess(
      [
        process.execPath,
        "-e",
        `import { runCli } from ${JSON.stringify(dispatcher)};
        await runCli({ argv: ${JSON.stringify(call.argv)}, rootUrl: "", hostProxy: ${JSON.stringify(call)} });`,
      ],
      fixture,
    );

    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "HostProxyCommandNotAllowedError" },
    });
    expect(await Bun.file(appToolingCompilationCachePath(fixture.cacheRoot, fixture.root)).exists()).toBe(
      false,
    );
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("a failed rebuild keeps the original missing-cache remediation", async () => {
  const fixture = await makeFixture("missing-broken");
  try {
    await writeFile(
      join(fixture.root, ".lando.yml"),
      "name: router-missing-broken\nservices: [not, a, map]\n",
    );

    const result = await runSource(fixture, ["probe", "--format=json"]);

    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "ToolingCommandUnavailableError",
        reason: "missing-cache",
        remediation: expect.stringContaining("lando app:cache:refresh"),
      },
    });
    expect(await Bun.file(appToolingCompilationCachePath(fixture.cacheRoot, fixture.root)).exists()).toBe(
      false,
    );
  } finally {
    await fixture.cleanup();
  }
}, 30_000);
