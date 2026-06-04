#!/usr/bin/env bun
/**
 * Distribution bundle packaging + verification.
 *
 * Default mode walks a bundle directory, computes a sha256 over every compiled
 * `lando-*` binary, and writes a `sha256sum`-compatible `SHA256SUMS` file.
 * `--verify` mode recomputes each listed digest and exits non-zero on any
 * mismatch or missing file, so the nightly distribution rehearsal can assert
 * the packaged sums match the binaries it produced.
 *
 * This runs outside `LandoRuntimeLive`, so it MAY touch the filesystem
 * directly; it is build tooling, not production source.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const SHA256SUMS_FILENAME = "SHA256SUMS";

export interface Sha256Entry {
  readonly name: string;
  readonly hash: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatches: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

export const computeSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** `sha256sum`-compatible: `<64-hex>` + two spaces + filename, newline-terminated. */
export const formatSha256Sums = (entries: ReadonlyArray<Sha256Entry>): string =>
  `${entries.map((entry) => `${entry.hash}  ${entry.name}`).join("\n")}\n`;

export const parseSha256Sums = (content: string): ReadonlyArray<Sha256Entry> =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (match === null) {
        throw new Error(`Malformed SHA256SUMS line: ${line}`);
      }
      return { hash: match[1], name: match[2] } satisfies Sha256Entry;
    });

const readBytes = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(path).arrayBuffer());

/** Compiled binaries only: `lando-*`, excluding the sums file and sourcemaps. */
export const listBundleBinaries = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.startsWith("lando-") &&
        name !== SHA256SUMS_FILENAME &&
        !name.endsWith(".map") &&
        !name.endsWith(".json"),
    )
    .sort();
};

export const writeSha256Sums = async (dir: string): Promise<string> => {
  const names = await listBundleBinaries(dir);
  if (names.length === 0) {
    throw new Error(`No bundle binaries found in ${dir}`);
  }

  const entries: Array<Sha256Entry> = [];
  for (const name of names) {
    const hash = computeSha256(await readBytes(resolve(dir, name)));
    entries.push({ name, hash });
  }

  const content = formatSha256Sums(entries);
  await writeFile(resolve(dir, SHA256SUMS_FILENAME), content);
  return content;
};

export const verifySums = async (dir: string, sumsContent: string): Promise<VerifyResult> => {
  const entries = parseSha256Sums(sumsContent);
  const mismatches: Array<string> = [];
  const missing: Array<string> = [];

  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (!(await Bun.file(path).exists())) {
      missing.push(entry.name);
      continue;
    }
    if (computeSha256(await readBytes(path)) !== entry.hash) {
      mismatches.push(entry.name);
    }
  }

  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const dir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "dist/bundle");

  if (verify) {
    const sumsPath = resolve(dir, SHA256SUMS_FILENAME);
    if (!(await Bun.file(sumsPath).exists())) {
      console.error(`[dist-bundle] missing ${SHA256SUMS_FILENAME} in ${dir}`);
      process.exit(1);
    }

    const content = await readFile(sumsPath, "utf8");
    const result = await verifySums(dir, content);
    if (!result.ok) {
      for (const name of result.mismatches) {
        console.error(`[dist-bundle] checksum mismatch: ${name}`);
      }
      for (const name of result.missing) {
        console.error(`[dist-bundle] missing file: ${name}`);
      }
      process.exit(1);
    }

    console.log(`[dist-bundle] verified ${parseSha256Sums(content).length} checksums in ${dir}`);
    return;
  }

  const content = await writeSha256Sums(dir);
  console.log(
    `[dist-bundle] wrote ${SHA256SUMS_FILENAME} for ${parseSha256Sums(content).length} binaries in ${dir}`,
  );
};

if (import.meta.main) {
  await main();
}
