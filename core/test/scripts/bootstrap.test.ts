import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A checkout with no node_modules that runs the real bootstrap scripts over stub workspaces, so
 * install, codegen, the SDK build, and the helper build each take milliseconds.
 */
const freshCheckout = async (restore: object): Promise<AsyncDisposable & { readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "lando-bootstrap-fresh-"));
  const files: Record<string, string> = {
    "bunfig.toml": '[install]\nlinker = "hoisted"\n',
    "package.json": json({
      name: "bootstrap-fixture",
      private: true,
      workspaces: ["container-runtime", "core", "sdk"],
      scripts: { codegen: "bun --version" },
    }),
    "sdk/package.json": json({ name: "@lando/sdk", version: "0.0.0", scripts: { build: "bun --version" } }),
    "core/package.json": json({
      name: "@lando/core",
      version: "0.0.0",
      scripts: { "build:container-helper": "bun --version" },
    }),
    "container-runtime/package.json": json({
      name: "@lando/container-runtime",
      version: "0.0.0",
      exports: { "./container-helper/source": "./source.ts" },
    }),
    "container-runtime/source.ts":
      'export const containerHelperSourceDigest = async () => "fixture-digest";\n',
    "scripts/container-helper-cache.ts": [
      'export const defaultContainerHelperCacheRoot = () => "fixture-cache";',
      `export const restoreContainerHelper = async () => (${JSON.stringify(restore)});`,
      'export const publishContainerHelper = async () => "published";',
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const script of ["scripts/bootstrap.ts", "scripts/bootstrap-container-helper.ts"])
    await copyFile(join(repoRoot, script), join(root, script));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
};

test.each([
  {
    name: "restores the helper",
    restore: { status: "restored", entry: "fixture-cache/fixture-digest" },
    args: [],
    exitCode: 0,
    expected: {
      ok: true,
      helper: { status: "restored", sourceDigest: "fixture-digest", detail: "fixture-cache/fixture-digest" },
    },
  },
  {
    name: "names the build command on a cache miss",
    restore: { status: "missing", reason: "no cache entry" },
    args: [],
    exitCode: 1,
    expected: {
      ok: false,
      helper: { status: "missing", sourceDigest: "fixture-digest", detail: "no cache entry" },
      next: "bun run bootstrap --build-helper",
    },
  },
  {
    name: "builds the helper on a cache miss with --build-helper",
    restore: { status: "missing", reason: "no cache entry" },
    args: ["--build-helper"],
    exitCode: 0,
    expected: { ok: true, helper: { status: "built", sourceDigest: "fixture-digest" } },
  },
])(
  "the first bootstrap in a checkout without node_modules $name",
  async ({ restore, args, exitCode, expected }) => {
    await using checkout = await freshCheckout(restore);
    const child = Bun.spawn([process.execPath, "scripts/bootstrap.ts", "--json", ...args], {
      cwd: checkout.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(exitCode);
    const { steps, ...report } = JSON.parse(stdout);
    expect(report).toEqual(expected);
    expect(
      steps.map((step: { readonly id: string; readonly status: string }) => [step.id, step.status]),
    ).toEqual([
      ["install", "ok"],
      ["codegen", "ok"],
      ["sdk build", "ok"],
    ]);
  },
);
