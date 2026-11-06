#!/usr/bin/env bun
/**
 * Compares two runtime-bundle archives assembled from the same commit and names every member
 * whose bytes or link target differ. Nightly runs it against an independent rebuild.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseTarEntries } from "../plugins/provider-lando/src/debian-archive.ts";

export interface RuntimeBundleComparison {
  readonly identical: boolean;
  /** Members that differ or exist in only one archive; empty when only archive metadata differs. */
  readonly differingMembers: ReadonlyArray<string>;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const memberDigests = (archive: Uint8Array<ArrayBuffer>): ReadonlyMap<string, string> =>
  new Map(
    parseTarEntries(Bun.gunzipSync(archive)).map((entry) => [
      entry.name,
      entry.kind === "file" ? sha256Hex(entry.bytes ?? new Uint8Array()) : `-> ${entry.linkname ?? ""}`,
    ]),
  );

export const compareRuntimeBundleArchives = (
  reference: Uint8Array<ArrayBuffer>,
  rebuild: Uint8Array<ArrayBuffer>,
): RuntimeBundleComparison => {
  if (sha256Hex(reference) === sha256Hex(rebuild)) return { identical: true, differingMembers: [] };
  const left = memberDigests(reference);
  const right = memberDigests(rebuild);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return { identical: false, differingMembers: names.filter((name) => left.get(name) !== right.get(name)) };
};

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [referencePath, rebuildPath] = argv;
  if (referencePath === undefined || rebuildPath === undefined || argv.length !== 2) {
    throw new Error("usage: check-runtime-bundle-reproducibility.ts <reference.tar.gz> <rebuild.tar.gz>");
  }
  const [reference, rebuild] = await Promise.all([readFile(referencePath), readFile(rebuildPath)]);
  process.stdout.write(`reference sha256=${sha256Hex(reference)}\nrebuild   sha256=${sha256Hex(rebuild)}\n`);
  const comparison = compareRuntimeBundleArchives(reference, rebuild);
  if (comparison.identical) {
    process.stdout.write("::notice title=runtime-bundle-reproducibility::rebuild is byte-identical\n");
    return;
  }
  const detail =
    comparison.differingMembers.length === 0
      ? "every member matches; the archive metadata (order, modes, owners, or timestamps) differs"
      : `${comparison.differingMembers.length} member(s) differ: ${comparison.differingMembers.join(", ")}`;
  process.stdout.write(
    `::error title=runtime-bundle-reproducibility::rebuild differs from the reference; ${detail}\n`,
  );
  process.exitCode = 1;
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
