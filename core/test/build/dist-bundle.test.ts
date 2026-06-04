import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  SHA256SUMS_FILENAME,
  computeSha256,
  formatSha256Sums,
  listBundleBinaries,
  parseSha256Sums,
  verifySums,
  writeSha256Sums,
} from "../../../scripts/dist-bundle.ts";

describe("dist-bundle sha256 packaging", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "lando-dist-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("computeSha256 returns the canonical lowercase hex digest", () => {
    expect(computeSha256(new TextEncoder().encode("lando"))).toBe(
      "eeb9e6d37b25bbbf28d2d2d956ca02cbe171ec692ebee73d7c93bef1ddfee393",
    );
  });

  test("formatSha256Sums emits sha256sum-compatible two-space lines", () => {
    const out = formatSha256Sums([{ name: "lando-linux-x64", hash: "a".repeat(64) }]);
    expect(out).toBe(`${"a".repeat(64)}  lando-linux-x64\n`);
  });

  test("parseSha256Sums round-trips formatSha256Sums", () => {
    const entries = [
      { name: "lando-darwin-arm64", hash: "a".repeat(64) },
      { name: "lando-windows-x64.exe", hash: "b".repeat(64) },
    ];

    expect(parseSha256Sums(formatSha256Sums(entries))).toEqual(entries);
  });

  test("parseSha256Sums rejects a malformed line", () => {
    expect(() => parseSha256Sums("not-a-checksum-line")).toThrow(/Malformed/);
  });

  test("listBundleBinaries keeps lando-* binaries and drops SHA256SUMS + sourcemaps", async () => {
    await writeFile(resolve(dir, "lando-linux-x64"), "a");
    await writeFile(resolve(dir, "lando-windows-x64.exe"), "b");
    await writeFile(resolve(dir, "lando-linux-x64.map"), "map");
    await writeFile(resolve(dir, SHA256SUMS_FILENAME), "x");
    await writeFile(resolve(dir, "manifest.json"), "{}");

    expect(await listBundleBinaries(dir)).toEqual(["lando-linux-x64", "lando-windows-x64.exe"]);
  });

  test("writeSha256Sums + verifySums pass for matching binaries", async () => {
    await writeFile(resolve(dir, "lando-linux-x64"), "binary-a");
    await writeFile(resolve(dir, "lando-windows-x64.exe"), "binary-b");

    const content = await writeSha256Sums(dir);
    expect(parseSha256Sums(content)).toHaveLength(2);

    const result = await verifySums(dir, content);
    expect(result).toEqual({ ok: true, mismatches: [], missing: [], unexpected: [] });
  });

  test("writeSha256Sums fails loudly when no binaries are present", async () => {
    await expect(writeSha256Sums(dir)).rejects.toThrow(/No bundle binaries/);
  });

  test("verifySums fails when a binary is tampered after the sums are written", async () => {
    await writeFile(resolve(dir, "lando-linux-x64"), "binary-a");
    const content = await writeSha256Sums(dir);

    await writeFile(resolve(dir, "lando-linux-x64"), "TAMPERED");

    const result = await verifySums(dir, content);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(["lando-linux-x64"]);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  test("verifySums reports an unexpected binary omitted from the sums", async () => {
    await writeFile(resolve(dir, "lando-linux-x64"), "binary-a");
    const content = await writeSha256Sums(dir);

    await writeFile(resolve(dir, "lando-darwin-x64"), "binary-b");

    const result = await verifySums(dir, content);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(["lando-darwin-x64"]);
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  test("verifySums reports a missing binary listed in the sums", async () => {
    const content = formatSha256Sums([{ name: "lando-darwin-arm64", hash: "c".repeat(64) }]);

    const result = await verifySums(dir, content);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["lando-darwin-arm64"]);
    expect(result.mismatches).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
});
