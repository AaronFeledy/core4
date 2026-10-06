import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandIndexEntry } from "@lando/engine/cache/command-index";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const script = "# ---\n# desc: Freshness probe\n# ---\necho -n probe-output\n";

const withApp = async (run: (root: string, cacheRoot: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-cli-script-freshness-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: freshness\n");
    await run(root, join(root, "cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const cache = (
  root: string,
  cacheRoot: string,
  policy: {
    readonly commandAliases?: LandofileShape["commandAliases"];
    readonly entries?: readonly CommandIndexEntry[];
  } = {},
) =>
  Effect.runPromise(
    writeAppCommandCacheStrict({
      cwd: root,
      cacheRoot,
      landofile: {
        name: "freshness",
        ...(policy.commandAliases === undefined ? {} : { commandAliases: policy.commandAliases }),
      },
      entries: policy.entries ?? [],
    }),
  );

const invoke = async (root: string, cacheRoot: string, name: string) => {
  const child = Bun.spawn([process.execPath, cli, name, "-j"], {
    cwd: root,
    env: {
      ...process.env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("a fresh-index miss runs only the newly added nested script without parsing the Landofile", async () => {
  await withApp(async (root, cacheRoot) => {
    await writeFile(join(root, ".lando.yml"), "name: [unparseable\n");
    await cache(root, cacheRoot);
    await mkdir(join(root, ".lando/scripts/ops"));
    await writeFile(join(root, ".lando/scripts/ops/probe.bun.sh"), script);
    await writeFile(join(root, ".lando/scripts/unrelated.bun.sh"), "invalid front-matter");
    const result = await invoke(root, cacheRoot, "app:ops:probe");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: "probe-output" } });
  });
}, 30_000);

test("an indexed mixed-case script runs its edited body without refresh", async () => {
  await withApp(async (root, cacheRoot) => {
    const path = join(root, ".lando/scripts/Probe.bun.sh");
    await writeFile(path, script);
    await cache(root, cacheRoot, {
      entries: [{ id: "app:probe", summary: "Freshness probe", hidden: false, source: "bun-script" }],
    });
    await writeFile(path, script.replace("probe-output", "edited-output"));
    const result = await invoke(root, cacheRoot, "probe");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: "edited-output" } });
  });
}, 30_000);

test("a removed indexed script reports no longer available with refresh remediation", async () => {
  await withApp(async (root, cacheRoot) => {
    const path = join(root, ".lando/scripts/probe.bun.sh");
    await writeFile(path, script);
    await cache(root, cacheRoot, {
      entries: [{ id: "app:probe", summary: "Probe", hidden: false, source: "bun-script" }],
    });
    await rm(path);
    const result = await invoke(root, cacheRoot, "probe");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "ToolingCompileError",
        message: expect.stringContaining("no longer available"),
        remediation: expect.stringContaining("app:cache:refresh"),
      },
    });
  });
}, 30_000);

test.each([
  {
    label: "disabled alias",
    policy: { commandAliases: { disabled: ["blocked"] } },
    expected: "alias-disabled",
  },
  {
    label: "disabled alias system",
    policy: {
      commandAliases: { enabled: false, custom: { blocked: "app:known" } },
      entries: [{ id: "app:known", summary: "Known", hidden: false }],
    },
    expected: "alias-disabled",
  },
  {
    label: "custom alias precedence",
    policy: {
      commandAliases: { custom: { blocked: "app:known" } },
      entries: [{ id: "app:known", summary: "Known", hidden: false }],
    },
    expected: "tooling",
  },
  {
    label: "disabled task precedence",
    policy: { entries: [{ id: "app:blocked", summary: "Disabled", hidden: true }] },
    expected: "tooling",
  },
] satisfies readonly { label: string; policy: Parameters<typeof cache>[2]; expected: string }[])(
  "fresh-index fallback honors $label",
  async ({ policy, expected }) => {
    await withApp(async (root, cacheRoot) => {
      await cache(root, cacheRoot, policy);
      await writeFile(join(root, ".lando/scripts/probe.bun.sh"), script);
      await writeFile(join(root, ".lando/scripts/blocked.bun.sh"), script);
      const routes = await Promise.all(
        ["probe", "blocked"].map((name) =>
          Effect.runPromise(resolveToolingRoute(name, { cwd: root, cacheRoot })),
        ),
      );
      expect(routes[0]).toMatchObject({ _tag: "bun-script", commandId: "app:probe" });
      expect(routes[1]).toMatchObject({ _tag: expected });
      if (policy?.entries?.some((entry) => entry.hidden)) expect(routes[1]).toMatchObject({ hidden: true });
    });
  },
);

test("a new script becomes unavailable after the Landofile changes", async () => {
  await withApp(async (root, cacheRoot) => {
    await cache(root, cacheRoot);
    await writeFile(join(root, ".lando/scripts/probe.bun.sh"), script);
    expect(await Effect.runPromise(resolveToolingRoute("probe", { cwd: root, cacheRoot }))).toMatchObject({
      _tag: "bun-script",
    });
    await writeFile(join(root, ".lando.yml"), "name: freshness\n# changed\n");
    const result = await invoke(root, cacheRoot, "probe");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "ToolingCompileError",
        remediation: expect.stringContaining("app:cache:refresh"),
      },
    });
  });
}, 30_000);

test("a malformed script reports its front matter instead of a cache refresh", async () => {
  await withApp(async (root, cacheRoot) => {
    await cache(root, cacheRoot);
    await writeFile(join(root, ".lando/scripts/broken.bun.sh"), "invalid front-matter\n");
    const result = await invoke(root, cacheRoot, "broken");
    expect(result.code, result.stderr + result.stdout).toBe(1);
    const body = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { _tag?: string; message?: string; remediation?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error._tag).toBe("BunShellScriptFrontMatterError");
    expect(body.error.message).toContain("front-matter");
    expect(JSON.stringify(body.error)).not.toContain("app:cache:refresh");
  });
}, 30_000);
