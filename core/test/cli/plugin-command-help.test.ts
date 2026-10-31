import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { ToolingInputRevision } from "@lando/sdk/schema";
import { Effect } from "effect";

const repo = resolve(import.meta.dirname, "../../..");
const cli = join(repo, "core/bin/lando.ts");
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-help-"));
  const env = {
    ...process.env,
    LANDO_TEST_API_TOKEN: "",
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONFIG_ROOT: join(root, "config"),
    LANDO_USER_CONF_ROOT: join(root, "config"),
  };
  const invoke = async (args: readonly string[], cwd = root) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  return { root, env, invoke, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const installLocalPlugin = async (
  root: string,
  marker: string,
  options: { readonly id?: string; readonly summary?: string } = {},
) => {
  const id = options.id ?? "local:inspect";
  const plugins = join(root, ".lando/plugins");
  const path = join(plugins, "fixture");
  await mkdir(path, { recursive: true });
  const manifest = {
    name: "@example/local-help",
    version: "1.0.0",
    api: 4,
    entry: "index.ts",
    description: "Local fixture commands.",
    contributes: { commands: [id] },
  };
  await writeFile(join(path, "package.json"), JSON.stringify({ landoPlugin: manifest }));
  await writeFile(
    join(plugins, "registry.json"),
    JSON.stringify({ [manifest.name]: { name: manifest.name, version: manifest.version, path } }),
  );
  await writeFile(
    join(path, "index.ts"),
    `import { writeFileSync } from "node:fs";
import { Schema } from "effect";
import { RuntimeCwd } from ${JSON.stringify(join(repo, "engine/src/runtime/cwd.ts"))};
writeFileSync(${JSON.stringify(marker)}, "acquired");
export const commands = new Map([[${JSON.stringify(id)}, async () => ({
  id: ${JSON.stringify(id)}, namespace: ${JSON.stringify(id.split(":")[0])}, summary: ${JSON.stringify(options.summary ?? "Inspect local fixture.")},
  bootstrap: "plugins", resultSchema: Schema.String, run: () => RuntimeCwd,
})]]);`,
  );
};

test("bundled commands appear in text, JSON/YAML catalogs and namespace help", async () => {
  const f = await fixture();
  try {
    const all = await f.invoke(["help", "--all"]);
    expect(all.exit, all.stderr).toBe(0);
    expect(all.stdout).toMatch(/db:export\s+Export a database dump from a service\./u);
    for (const format of ["json", "yaml"]) {
      const result = await f.invoke(["help", "--format", format]);
      const envelope = format === "json" ? JSON.parse(result.stdout) : Bun.YAML.parse(result.stdout);
      expect(envelope.result.pluginMetadata.status).toBe("available");
      expect(envelope.result.all).toContainEqual(
        expect.objectContaining({ canonicalId: "db:export", source: "plugin", plugin: "@lando/sql" }),
      );
    }
    for (const args of [
      ["help", "db"],
      ["db", "--help"],
    ]) {
      const result = await f.invoke(args);
      expect(result.exit, result.stderr).toBe(0);
      expect(result.stdout).toContain("DB");
      expect(result.stdout.match(/^ {2}db:/gmu)).toHaveLength(8);
    }
    const topic = await f.invoke(["help", "db", "--format", "json"]);
    expect(JSON.parse(topic.stdout).result.all).toContainEqual(
      expect.objectContaining({ canonicalId: "db:export" }),
    );
  } finally {
    await f.cleanup();
  }
}, 15000);

test.each([{ args: ["help", "db:export"] }, { args: ["db:export", "--help"] }])(
  "plugin target $args emits only a machine envelope",
  async ({ args }) => {
    const f = await fixture();
    try {
      const result = await f.invoke([...args, "--format", "json"]);
      expect(result.exit, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).result.target).toMatchObject({
        canonicalId: "db:export",
        typeable: "db:export",
        source: "plugin",
        plugin: "@lando/sql",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  ["export", "lando db:export"],
  ["db:exprt", "lando help db"],
  ["db", "lando help db"],
  ["app", "lando help app"],
])("unknown %s offers %s", async (token, hint) => {
  const f = await fixture();
  try {
    const result = await f.invoke([token, "--format", "json"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      _tag: "UnknownCommandError",
      remediation: expect.stringContaining(hint),
    });
  } finally {
    await f.cleanup();
  }
});

test.each(["fresh", "missing", "stale"])(
  "positive tooling ownership with a %s cache",
  async (state) => {
    const f = await fixture();
    try {
      const landofile = {
        name: "plugin-help",
        tooling: { db: { cmd: "echo tooling", description: "Owned tooling DB" } },
      };
      await writeFile(
        join(f.root, ".lando.yml"),
        "name: plugin-help\ntooling:\n  db:\n    cmd: echo tooling\n    description: Owned tooling DB\n",
      );
      const path = await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [
            {
              id: "app:db",
              summary: "Owned tooling DB",
              hidden: false,
              input: {
                flags: [],
                args: [],
                acceptsArguments: false,
                revision: ToolingInputRevision.make("fixture"),
              },
            },
          ],
          cwd: f.root,
          cacheRoot: f.env.LANDO_USER_CACHE_ROOT,
        }),
      );
      if (state === "missing") {
        if (path !== undefined) await rm(path);
        await rm(appToolingCompilationCachePath(f.env.LANDO_USER_CACHE_ROOT, f.root));
      }
      if (state === "stale") await writeFile(join(f.root, ".lando.yml"), "name: changed-help\n");
      for (const args of [
        ["help", "db"],
        ["db", "--help"],
      ]) {
        const result = await f.invoke(args);
        expect(result.exit, result.stderr).toBe(0);
        expect(result.stdout).toContain(state === "fresh" ? "Owned tooling DB" : "db:export");
        if (state === "fresh") expect(result.stdout).not.toContain("db:export");
      }
      if (state !== "fresh") {
        const bare = await f.invoke(["db", "--format", "json"]);
        expect(bare.exit).toBe(1);
        expect(JSON.parse(bare.stdout).error).toMatchObject({
          _tag: "ToolingCommandUnavailableError",
          remediation: expect.stringContaining("lando help db"),
        });
        const explicit = await f.invoke(["app:db", "--help", "--format", "json"]);
        expect(JSON.parse(explicit.stdout).error._tag).toBe("ToolingCommandUnavailableError");
      }
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test("nested app plugin discovery does not parse a malformed Landofile", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: [malformed\n");
    await installLocalPlugin(f.root, join(f.root, "imported"));
    const nested = join(f.root, "nested/deeper");
    await mkdir(nested, { recursive: true });
    const result = await f.invoke(["help", "--all", "--format", "json"], nested);
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.all).toContainEqual(
      expect.objectContaining({
        canonicalId: "local:inspect",
        source: "plugin",
        plugin: "@example/local-help",
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("cold root, built-in target and core topic help do not acquire plugin entries", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: help-import\n");
    const marker = join(f.root, "imported");
    await installLocalPlugin(f.root, marker);
    await mkdir(f.env.LANDO_USER_DATA_ROOT, { recursive: true });
    await symlink(join(f.root, ".lando/plugins"), join(f.env.LANDO_USER_DATA_ROOT, "plugins"));
    const cold = await f.invoke(["--help"], tmpdir());
    expect(cold.exit, cold.stderr).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    for (const args of [["--help"], ["help", "app:start"], ["app:start", "--help"], ["help", "app"]]) {
      const result = await f.invoke(args);
      expect(result.exit, result.stderr).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    }
    const warm = await f.invoke(["help", "--all"]);
    expect(warm.exit, warm.stderr).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  } finally {
    await f.cleanup();
  }
}, 15000);

test("repeated programmatic runCli calls acquire discovery for each cwd", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: repeated-help\n");
    await installLocalPlugin(f.root, join(f.root, "imported"));
    const script = `import {runCli} from ${JSON.stringify(join(repo, "core/src/cli/index.ts"))};
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
for (const cwd of ${JSON.stringify([f.root, tmpdir()])}) await runCli({ argv: ["help", "--format=json"], rootUrl: ${JSON.stringify(cli)}, discovery: {cwd, resolver: makeAppDiscoveryResolver()} });`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: repo,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
    const results = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).result);
    expect(results).toHaveLength(2);
    expect(results[0].all).toContainEqual(expect.objectContaining({ canonicalId: "local:inspect" }));
    expect(results[1].all).not.toContainEqual(expect.objectContaining({ canonicalId: "local:inspect" }));
  } finally {
    await f.cleanup();
  }
}, 15000);

test("unavailable plugin discovery is reported by help instead of an unknown command", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: unavailable-discovery\n");
    await installLocalPlugin(f.root, join(f.root, "imported"));
    // A loader the manifest does not declare fails graph acquisition for every plugin command.
    const manifestPath = join(f.root, ".lando/plugins/fixture/package.json");
    const packageJson = await Bun.file(manifestPath).json();
    packageJson.landoPlugin.contributes.commands = [];
    await writeFile(manifestPath, JSON.stringify(packageJson));

    const target = await f.invoke(["help", "local:inspect", "--format", "json"]);
    expect(target.exit).not.toBe(0);
    const targetError = JSON.parse(target.stdout).error;
    expect(targetError._tag).not.toBe("UnknownCommandError");
    expect(targetError.message).toContain("@example/local-help");

    const catalog = await f.invoke(["help", "--format", "json"]);
    expect(catalog.exit, catalog.stderr).toBe(0);
    const result = JSON.parse(catalog.stdout).result;
    expect(result.pluginMetadata.status).toBe("unavailable");
    expect(result.all).toContainEqual(
      expect.objectContaining({ canonicalId: "app:start", source: "built-in" }),
    );

    const colonToken = await f.invoke(["meta:no-such-command", "--format", "json"]);
    expect(JSON.parse(colonToken.stdout).error._tag).toBe(targetError._tag);
  } finally {
    await f.cleanup();
  }
});

test.each([
  { args: ["help", "--all", "--format=json"] },
  { args: ["help", "local:inspect", "--format=json"] },
  { args: ["help", "local:inspect"] },
  { args: ["help", "local"] },
  { args: ["help", "--all"] },
])("plugin metadata is redacted for $args", async ({ args }) => {
  // Given
  const f = await fixture();
  const secret = "plugin-help-secret-123456789";
  f.env.LANDO_TEST_API_TOKEN = secret;
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: redacted-help\n");
    await installLocalPlugin(f.root, join(f.root, "imported"), { summary: `Inspect ${secret}` });
    // When
    const result = await f.invoke(args);
    // Then
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).not.toContain(secret);
  } finally {
    await f.cleanup();
  }
});

test.each(["fresh", "missing"])(
  "app namespace plugin respects %s tooling ownership",
  async (state) => {
    // Given
    const f = await fixture();
    try {
      await writeFile(join(f.root, ".lando.yml"), "name: app-plugin\n");
      await installLocalPlugin(f.root, join(f.root, "imported"), { id: "app:inspect" });
      if (state === "fresh")
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: { name: "app-plugin" },
            entries: [],
            cwd: f.root,
            cacheRoot: f.env.LANDO_USER_CACHE_ROOT,
          }),
        );
      // When
      for (const args of [["app:inspect"], ["app:inspect", "--help"], ["help", "app:inspect"]]) {
        const result = await f.invoke([...args, "--format=json"]);
        // Then
        expect(result.exit, result.stderr).toBe(state === "fresh" ? 0 : 1);
        const envelope = JSON.parse(result.stdout);
        if (state === "missing") expect(envelope.error._tag).toBe("ToolingCommandUnavailableError");
        else if (args.length === 1) expect(envelope.result).toBe(f.root);
        else expect(envelope.result.target).toMatchObject({ canonicalId: "app:inspect", source: "plugin" });
      }
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test("programmatic plugin execution uses discovery cwd rather than process cwd", async () => {
  // Given
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: execution-cwd\n");
    await installLocalPlugin(f.root, join(f.root, "imported"));
    const script = `import {runCli} from ${JSON.stringify(join(repo, "core/src/cli/index.ts"))};
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
await runCli({ argv: ["local:inspect", "--format=json"], rootUrl: ${JSON.stringify(cli)}, discovery: {cwd: ${JSON.stringify(f.root)}, resolver: makeAppDiscoveryResolver()} });`;
    // When
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: repo,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // Then
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout).result).toBe(f.root);
  } finally {
    await f.cleanup();
  }
});

test("full listings omit plugin rows owned by fresh app tooling", async () => {
  // Given
  const f = await fixture();
  try {
    await writeFile(
      join(f.root, ".lando.yml"),
      "name: tooling-winner\ntooling:\n  inspect:\n    cmd: echo tooling\n",
    );
    await installLocalPlugin(f.root, join(f.root, "imported"), {
      id: "app:inspect",
      summary: "Shadowed plugin fixture",
    });
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        landofile: { name: "tooling-winner", tooling: { inspect: { cmd: "echo tooling" } } },
        entries: [
          {
            id: "app:inspect",
            summary: "Winning tooling fixture",
            hidden: false,
            input: {
              flags: [],
              args: [],
              acceptsArguments: false,
              revision: ToolingInputRevision.make("fixture"),
            },
          },
        ],
        cwd: f.root,
        cacheRoot: f.env.LANDO_USER_CACHE_ROOT,
      }),
    );
    // When
    const text = await f.invoke(["help", "--all"]);
    const machine = await f.invoke(["help", "--format=json"]);
    const target = await f.invoke(["help", "app:inspect", "--format=json"]);
    // Then
    expect(text.exit, text.stderr).toBe(0);
    expect(text.stdout).not.toContain("Shadowed plugin fixture");
    expect(text.stdout).toContain("Winning tooling fixture");
    expect(machine.exit, machine.stderr).toBe(0);
    expect(
      JSON.parse(machine.stdout).result.all.filter(
        (row: { canonicalId: string }) => row.canonicalId === "app:inspect",
      ),
    ).toEqual([expect.objectContaining({ source: "tooling" })]);
    expect(target.exit, target.stderr).toBe(0);
    expect(JSON.parse(target.stdout).result.target.source).toBe("tooling");
  } finally {
    await f.cleanup();
  }
}, 30000);

test.each(["plain", "lando"])("plugin topic honors active %s renderer on a TTY", async (renderer) => {
  // Given
  const f = await fixture();
  try {
    await writeFile(join(f.root, ".lando.yml"), "name: styled-topic\n");
    await installLocalPlugin(f.root, join(f.root, "imported"));
    const script = `import {runCli} from ${JSON.stringify(join(repo, "core/src/cli/index.ts"))};
Object.defineProperty(process.stdout, "isTTY", { value: true });
delete process.env.NO_COLOR;
await runCli({ argv: ["help", "local", "--renderer=${renderer}"], rootUrl: ${JSON.stringify(cli)} });`;
    // When
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: f.root,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // Then
    expect(exit, stderr).toBe(0);
    expect(stdout).toContain("local:inspect");
    expect(stdout.includes("\x1b[")).toBe(renderer === "lando");
  } finally {
    await f.cleanup();
  }
});
