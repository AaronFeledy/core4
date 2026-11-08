import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { makeFixture, runProcess, runSource, sourceCli } from "./subprocess-support";

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

test.each(["stale", "invalid"])(
  "rebuilds a %s index and runs the edited task without a manual refresh",
  async (state) => {
    // Given an app whose index was built for `echo one`
    const fixture = await makeFixture(`rebuild-${state}`);
    const landofile = (word: string) =>
      `name: router-rebuild-${state}\ntooling:\n  hello:\n    service: ":host"\n    cmd: echo ${word}\n`;
    try {
      await writeFile(join(fixture.root, ".lando.yml"), landofile("one"));
      const first = await runSource(fixture, ["hello", "--format=json"]);
      expect(first.exitCode, first.stdout + first.stderr).toBe(0);
      // When the Landofile changes (stale) or the index bytes are corrupted (invalid)
      await writeFile(join(fixture.root, ".lando.yml"), landofile("two"));
      if (state === "invalid")
        await writeFile(appToolingCompilationCachePath(fixture.cacheRoot, fixture.root), "\u0000garbage");
      const result = await runSource(fixture, ["hello", "--format=json"]);
      // Then the task runs from the rebuilt index
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: "two\n" } });
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

test("help for a built-in leaves a stale index untouched", async () => {
  // Given an index built for `echo one`, then a Landofile edit that stales it
  const fixture = await makeFixture("stale-builtin-help");
  const landofile = (word: string) =>
    `name: router-stale-builtin-help\ntooling:\n  hello:\n    service: ":host"\n    cmd: echo ${word}\n`;
  try {
    await writeFile(join(fixture.root, ".lando.yml"), landofile("one"));
    expect((await runSource(fixture, ["hello", "--format=json"])).exitCode).toBe(0);
    const index = appToolingCompilationCachePath(fixture.cacheRoot, fixture.root);
    const before = await Bun.file(index).bytes();
    await writeFile(join(fixture.root, ".lando.yml"), landofile("two"));
    // When help targets a built-in command
    const result = await runSource(fixture, ["help", "app:info", "--format=json"]);
    // Then help renders without rebuilding the stale index
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(await Bun.file(index).bytes()).toEqual(before);
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

const slowLandofile = `export default async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { name: "router-slow-notice", tooling: { hello: { service: ":host", cmd: "echo slow" } } };
};
`;

const runInTerminal = async (fixture: Awaited<ReturnType<typeof makeFixture>>, argv: readonly string[]) => {
  let output = "";
  const child = Bun.spawn([process.execPath, sourceCli, ...argv], {
    cwd: fixture.root,
    env: fixture.env,
    terminal: {
      cols: 200,
      rows: 40,
      data: (_terminal, data) => {
        output += new TextDecoder().decode(data);
      },
    },
  });
  const exitCode = await child.exited;
  child.terminal?.close();
  return { exitCode, output };
};

test.skipIf(process.platform === "win32").each([
  { renderer: "the default", config: "", notice: true },
  { renderer: "a config-selected json", config: "renderer: json\n", notice: false },
])(
  "a slow rebuild on a terminal with $renderer renderer prints the notice only for humans",
  async ({ config, notice }) => {
    // Given a Landofile whose evaluation alone outlasts the notice delay, and no index yet
    const fixture = await makeFixture("slow-notice");
    try {
      await writeFile(join(fixture.root, ".lando.ts"), slowLandofile);
      await rm(join(fixture.root, ".lando.yml"));
      await mkdir(fixture.env.LANDO_USER_CONF_ROOT ?? "", { recursive: true });
      await writeFile(join(fixture.env.LANDO_USER_CONF_ROOT ?? "", "config.yml"), config);
      // When the task runs on a terminal
      const result = await runInTerminal(fixture, ["hello"]);
      // Then the task runs, and only human output gains the one-line notice
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("slow");
      expect(result.output.includes("Reading this app's commands...")).toBe(notice);
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

    expect(result.exitCode, result.stdout + result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "cli:unknown-command",
      error: { _tag: "UnknownCommandError", commandToken: "absent" },
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

test("a failed rebuild reports its own error and root help still renders", async () => {
  const fixture = await makeFixture("missing-broken");
  try {
    // Given a Landofile the rebuild cannot validate
    await writeFile(
      join(fixture.root, ".lando.yml"),
      "name: router-missing-broken\nservices: [not, a, map]\n",
    );

    // When dispatch and root help both need the app's commands
    const dispatch = await runSource(fixture, ["probe", "--format=json"]);
    const help = await runSource(fixture, ["--help", "--renderer=plain"]);
    const catalog = await runSource(fixture, ["help", "--format=json"]);

    // Then dispatch reports the rebuild's real failure, not a cache state
    expect(dispatch.exitCode, dispatch.stdout + dispatch.stderr).toBe(1);
    const envelope = JSON.parse(dispatch.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      command: "app:probe",
      error: { _tag: "LandofileValidationError" },
    });
    expect(dispatch.stdout).not.toContain("app:cache:refresh");
    // And help lists built-ins with the failure notice in place of app tooling
    expect(help.exitCode, help.stdout + help.stderr).toBe(0);
    expect(help.stdout).toMatch(/^\s+(?:app:)?start\s/mu);
    expect(help.stdout).toContain(`This app's commands are unavailable: ${envelope.error.message}`);
    expect(help.stdout).toContain(`  ↳ ${envelope.error.remediation}`);
    expect(catalog.exitCode, catalog.stdout + catalog.stderr).toBe(0);
    expect(JSON.parse(catalog.stdout)).toMatchObject({
      ok: true,
      result: {
        toolingMetadata: {
          status: "unavailable",
          reason: "rebuild-failed",
          error: { _tag: "LandofileValidationError", message: envelope.error.message },
        },
      },
    });
    expect(await Bun.file(appToolingCompilationCachePath(fixture.cacheRoot, fixture.root)).exists()).toBe(
      false,
    );
  } finally {
    await fixture.cleanup();
  }
}, 30_000);
