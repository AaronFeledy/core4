import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkNetworkBoundary } from "./check-network-boundary.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "network-boundary-"));
  await mkdir(join(root, "core", "src"), { recursive: true });
  await mkdir(join(root, "plugins", "x", "src"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeCore = async (name: string, contents: string): Promise<string> => {
  const file = join(root, "core", "src", name);
  await writeFile(file, contents);
  return `core/src/${name}`;
};

describe("check-network-boundary", () => {
  test("flags a direct global fetch call", async () => {
    await writeCore("a.ts", `export const f = async () => fetch("https://example.com");\n`);
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.match)).toContain("fetch");
  });

  test("flags globalThis.fetch and Bun.fetch calls", async () => {
    await writeCore(
      "b.ts",
      `export const a = () => globalThis.fetch("https://a");\nexport const b = () => Bun.fetch("https://b");\n`,
    );
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.match).sort()).toEqual(["Bun.fetch", "globalThis.fetch"]);
  });

  test("flags self.fetch and window.fetch calls", async () => {
    await writeCore(
      "w.ts",
      `export const a = () => self.fetch("https://a");\nexport const b = () => window.fetch("https://b");\n`,
    );
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.match).sort()).toEqual(["self.fetch", "window.fetch"]);
  });

  test("flags globalThis['fetch'] element-access call", async () => {
    await writeCore("e.ts", `export const a = () => globalThis["fetch"]("https://a");\n`);
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.match)).toContain("globalThis['fetch']");
  });

  test("ignores object-method fetch calls and aliases", async () => {
    await writeCore(
      "ok.ts",
      [
        "declare const client: { fetch: (u: string) => Promise<unknown> };",
        "declare const fetchImpl: (u: string) => Promise<unknown>;",
        `export const a = () => client.fetch("https://a");`,
        `export const b = () => fetchImpl("https://b");`,
        `export const c = (ctx: { fetch: (u: string) => Promise<unknown> }) => ctx.fetch("https://c");`,
        "",
      ].join("\n"),
    );
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);
  });

  test("ignores bare global fetch references used as injectable defaults", async () => {
    await writeCore(
      "ref.ts",
      [
        "export const make = (opts: { fetchImpl?: typeof fetch }) => {",
        "  const impl = opts.fetchImpl ?? globalThis.fetch;",
        "  return (u: string) => impl(u);",
        "};",
        "",
      ].join("\n"),
    );
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);
  });

  test("ignores .test.ts files", async () => {
    await writeCore("c.test.ts", `export const f = () => fetch("https://example.com");\n`);
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(true);
  });

  test("allows the HttpClient adapter file", async () => {
    await mkdir(join(root, "core", "src", "http-client"), { recursive: true });
    await writeFile(
      join(root, "core", "src", "http-client", "live.ts"),
      `export const f = (fetchImpl: typeof fetch) => () => fetchImpl("https://a");\nexport const g = () => fetch("https://b");\n`,
    );
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(true);
  });

  test("reports plugin offenders too", async () => {
    const file = join(root, "plugins", "x", "src", "p.ts");
    await writeFile(file, `export const f = () => fetch("https://a");\n`);
    const result = await checkNetworkBoundary({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.file)).toContain("plugins/x/src/p.ts");
  });
});
