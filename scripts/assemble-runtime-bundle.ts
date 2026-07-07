#!/usr/bin/env bun
/**
 * Assembles a runtime bundle for one host key from pinned upstream artifacts.
 *
 * Reads `plugins/provider-lando/runtime-bundle-sources.json`, downloads each
 * pinned component, verifies it against its committed SHA-256 (fail-closed),
 * lays the binaries out under a normalized path, and packs them into a
 * deterministic `lando-runtime-<hostKey>.tar.gz` / `.zip`. Re-running against
 * the same pins yields byte-identical archives (reproducible packing):
 * tar entries are sorted with a fixed mtime and numeric owner, and gzip is run
 * without its filename/timestamp header.
 *
 * This is build tooling — it runs outside `LandoRuntimeLive` and MAY touch the
 * filesystem, network, and subprocesses directly.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Schema } from "effect";

import { RUNTIME_BUNDLE_TARGETS, type RuntimeBundleTarget } from "./build-runtime-bundle.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PROVIDER_DIR = resolve(REPO_ROOT, "plugins", "provider-lando");
export const RUNTIME_BUNDLE_SOURCES_PATH = join(PROVIDER_DIR, "runtime-bundle-sources.json");
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, "dist", "cache", "runtime-bundle");

const Sha256 = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/u),
  Schema.filter((value) =>
    /^0+$/u.test(value) ? "placeholder (all-zero) sha256 is not allowed" : undefined,
  ),
);

const HttpsUrl = Schema.String.pipe(Schema.pattern(/^https:\/\//u));

const RuntimeBundleComponent = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.String.pipe(Schema.minLength(1)),
  url: HttpsUrl,
  sha256: Sha256,
  archive: Schema.Literal("none", "gz", "tar.gz", "zip"),
  member: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  installName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)),
  mode: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const RuntimeBundleGroup = Schema.Struct({
  components: Schema.Array(RuntimeBundleComponent).pipe(Schema.minItems(1)),
});

export const RuntimeBundleSources = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.String.pipe(Schema.minLength(1)),
  bundles: Schema.Record({ key: Schema.String, value: RuntimeBundleGroup }),
});

export type RuntimeBundleSources = Schema.Schema.Type<typeof RuntimeBundleSources>;
export type RuntimeBundleComponent = Schema.Schema.Type<typeof RuntimeBundleComponent>;

const decodeSources = Schema.decodeUnknownSync(RuntimeBundleSources);

export const parseRuntimeBundleSources = (value: unknown): RuntimeBundleSources => decodeSources(value);

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const targetFor = (hostKey: string): RuntimeBundleTarget => {
  const target = RUNTIME_BUNDLE_TARGETS.find((candidate) => candidate.key === hostKey);
  if (target === undefined) throw new Error(`assemble-runtime-bundle: unknown host key ${hostKey}`);
  return target;
};

const run = async (cmd: Array<string>, cwd?: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd,
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TZ: "UTC" },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0)
    throw new Error(`assemble-runtime-bundle: command failed (${exitCode}): ${cmd.join(" ")}`);
};

const extractMember = async (
  component: RuntimeBundleComponent,
  artifactPath: string,
  destPath: string,
): Promise<void> => {
  if (component.archive === "none") {
    await writeFile(destPath, await readFile(artifactPath));
    return;
  }
  if (component.archive === "gz") {
    await writeFile(destPath, Bun.gunzipSync(await readFile(artifactPath)));
    return;
  }
  if (component.member === undefined) {
    throw new Error(`assemble-runtime-bundle: ${component.name} archive requires a member path`);
  }
  const workDir = await mkdtemp(join(tmpdir(), "rb-extract-"));
  try {
    if (component.archive === "tar.gz") {
      await run(["tar", "-xzf", artifactPath, "-C", workDir, component.member]);
    } else {
      await run(["unzip", "-o", "-q", artifactPath, component.member, "-d", workDir]);
    }
    await writeFile(destPath, await readFile(join(workDir, component.member)));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

const packDeterministic = async (stageDir: string, artifactPath: string, isZip: boolean): Promise<void> => {
  if (isZip) {
    await run(["find", ".", "-exec", "touch", "-d", "@0", "{}", "+"], stageDir);
    await run(
      ["sh", "-c", 'files=$(find . -type f | sort); zip -X -D -q "$1" $files', "sh", artifactPath],
      stageDir,
    );
    return;
  }
  await run(
    [
      "sh",
      "-c",
      'tar --format=gnu --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | gzip -n -9 > "$1"',
      "sh",
      artifactPath,
    ],
    stageDir,
  );
};

export interface AssembleBundleOptions {
  readonly hostKey: string;
  readonly sources: RuntimeBundleSources;
  readonly outDir: string;
  readonly fetchArtifact: (url: string) => Promise<Uint8Array>;
}

export interface AssembledBundle {
  readonly hostKey: string;
  readonly filename: string;
  readonly artifactPath: string;
  readonly sha256: string;
}

export const assembleBundle = async (options: AssembleBundleOptions): Promise<AssembledBundle> => {
  const group = options.sources.bundles[options.hostKey];
  if (group === undefined) {
    throw new Error(`assemble-runtime-bundle: no components pinned for host key ${options.hostKey}`);
  }
  const target = targetFor(options.hostKey);
  const stageDir = await mkdtemp(join(tmpdir(), "rb-stage-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "rb-dl-"));
  try {
    for (const component of group.components) {
      const bytes = await options.fetchArtifact(component.url);
      const actual = sha256Hex(bytes);
      if (actual !== component.sha256) {
        throw new Error(
          `assemble-runtime-bundle: sha256 verify failed for ${component.name} (${component.url}): expected ${component.sha256}, got ${actual}`,
        );
      }
      const artifactPath = join(downloadDir, `${component.name}-${options.hostKey}`);
      await writeFile(artifactPath, bytes);
      const destPath = join(stageDir, component.installName);
      await mkdir(dirname(destPath), { recursive: true });
      await extractMember(component, artifactPath, destPath);
      await chmod(destPath, component.mode);
    }
    await mkdir(options.outDir, { recursive: true });
    const outPath = join(options.outDir, target.filename);
    await packDeterministic(stageDir, outPath, target.filename.endsWith(".zip"));
    const sha256 = sha256Hex(await readFile(outPath));
    return { hostKey: options.hostKey, filename: target.filename, artifactPath: outPath, sha256 };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    await rm(downloadDir, { recursive: true, force: true });
  }
};

const fetchOverHttps = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`assemble-runtime-bundle: download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  let hostKey: string | undefined;
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--platform") {
      hostKey = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--out-dir") {
      outDir = resolve(argv[i + 1] ?? "");
      i += 1;
    } else {
      throw new Error(`assemble-runtime-bundle: unknown argument ${argv[i]}`);
    }
  }
  if (hostKey === undefined) throw new Error("assemble-runtime-bundle: --platform <host-key> is required");
  const sources = parseRuntimeBundleSources(JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8")));
  const result = await assembleBundle({ hostKey, sources, outDir, fetchArtifact: fetchOverHttps });
  process.stdout.write(`${result.artifactPath}\n`);
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
