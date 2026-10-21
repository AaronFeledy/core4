#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { CONTAINER_HELPER_ARCHES } from "@lando/container-runtime/container-helper";
import { Effect } from "effect";

import { resolveContainerHelper } from "../core/src/container-helper/assets.ts";
import { containerHelperNotices } from "../core/src/container-helper/notices.ts";
import { CONTAINER_HELPER_SOURCE_ROOT } from "../core/src/container-helper/source.ts";

import { CI_PLATFORMS, type CiPlatform, isWindowsCiPlatform } from "./ci-platforms.ts";
import { compiledBinaryBundleConfig } from "./compiled-binary-bundle.ts";
import { CompiledBinaryVersionError, resolveCompiledBinaryVersion } from "./compiled-binary-version.ts";
import { WINDOWS_BRANDING, windowsPeVersion } from "./windows-branding.ts";

export { CompiledBinaryVersionError } from "./compiled-binary-version.ts";
export { createOpenTuiPruningPlugin, resolveOpenTuiNativeImport } from "./compiled-binary-bundle.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTFILE = resolve(REPO_ROOT, "core/dist/lando");

export interface CompiledBinaryOptions {
  readonly target?: string;
  readonly outfile: string;
  readonly version?: string;
  readonly metafileMd?: string;
}

export type CompiledBinaryBuildRunner = (config: Bun.BuildConfig) => Promise<Bun.BuildOutput>;
export type ContainerHelperAssetBuilder = (stagingDir: string) => Promise<readonly string[]>;

/**
 * Gzips the prebuilt static helper for every Linux arch into embeddable assets
 * named by digest. The helpers come from `LANDO_CONTAINER_HELPER_DIR` or from
 * `bun run build:container-helper`, which builds them with Lando.
 */
export const buildContainerHelperAssets: ContainerHelperAssetBuilder = async (stagingDir) => {
  await containerHelperNotices(
    process.env.LANDO_CONTAINER_HELPER_DIR ?? resolve(CONTAINER_HELPER_SOURCE_ROOT, "dist"),
  );
  const assets: string[] = [];
  for (const arch of CONTAINER_HELPER_ARCHES) {
    const helper = await Effect.runPromise(
      resolveContainerHelper({ os: "linux", arch }, { standalone: false }),
    );
    const asset = resolve(stagingDir, `lando-container-helper-linux-${arch}-${helper.digest}.gz`);
    await writeFile(asset, gzipSync(await readFile(helper.path), { level: 9 }));
    assets.push(asset);
  }
  return assets;
};

export class CompiledBinaryBuildError extends Error {
  override readonly name = "CompiledBinaryBuildError";

  constructor(readonly diagnostics: ReadonlyArray<Bun.BuildOutput["logs"][number]>) {
    const details = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    super(`Compiled binary build failed.${details === "" ? "" : `\n${details}`}`);
  }
}

const platformFor = (target: string): CiPlatform => {
  const platform = CI_PLATFORMS.find(
    (candidate) => candidate.id === target || candidate.bunTarget === target,
  );
  if (platform === undefined) throw new Error(`Unknown Lando release target: ${target}.`);
  return platform;
};

const bunTargetFor = (platform: CiPlatform): Bun.Build.CompileTarget => {
  switch (platform.bunTarget) {
    case "bun-darwin-arm64":
    case "bun-darwin-x64":
    case "bun-linux-arm64":
    case "bun-linux-x64":
    case "bun-windows-x64":
    case "bun-windows-arm64":
      return platform.bunTarget;
    default:
      throw new Error(`Unsupported Bun compile target: ${platform.bunTarget}.`);
  }
};

const hostTarget = (): string =>
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const emitMetafileMarkdown = async (options: CompiledBinaryOptions): Promise<void> => {
  if (options.metafileMd === undefined) return;

  const metafileMd = resolve(options.metafileMd);
  const stagingDir = await mkdtemp(resolve(tmpdir(), "lando-compile-metafile-"));
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        resolve(REPO_ROOT, "core/bin/lando.ts"),
        "--target=bun",
        "--format=esm",
        `--outfile=${resolve(stagingDir, "lando.js")}`,
        `--metafile-md=${metafileMd}`,
      ],
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`bun build --metafile-md failed with exit code ${exitCode}.`);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};

export const buildCompiledBinary = async (
  options: CompiledBinaryOptions,
  build: CompiledBinaryBuildRunner = (config) => Bun.build(config),
  prepareHelperAssets: ContainerHelperAssetBuilder = buildContainerHelperAssets,
  host: string = hostTarget(),
): Promise<Bun.BuildOutput> => {
  const platform = platformFor(options.target ?? hostTarget());
  const version = resolveCompiledBinaryVersion({
    ...(options.version === undefined ? {} : { explicit: options.version }),
    cwd: REPO_ROOT,
  });
  const stagingDir = await mkdtemp(resolve(tmpdir(), "lando-compile-shims-"));
  try {
    if (isWindowsCiPlatform(platform) && !isWindowsCiPlatform({ id: host })) {
      console.warn(
        `[build-compiled-binary] ${platform.id}: Bun cannot embed the Lando icon or version info when cross-compiling; this binary keeps Bun's defaults. Compile on Windows for a branded binary.`,
      );
    }
    const helperAssets = await prepareHelperAssets(stagingDir);
    const output = await build({
      ...compiledBinaryBundleConfig(platform.id, version, [
        resolve(REPO_ROOT, "core/bin/lando.ts"),
        ...helperAssets,
      ]),
      // Bun 1.4 compiled binaries no longer auto-load tsconfig.json / package.json.
      compile: {
        target: bunTargetFor(platform),
        outfile: options.outfile,
        // Bun applies PE branding only on Windows hosts; CI uses native Windows runners.
        ...(isWindowsCiPlatform(platform) && isWindowsCiPlatform({ id: host })
          ? { windows: { ...WINDOWS_BRANDING, version: windowsPeVersion(version) } }
          : {}),
      },
      bytecode: true,
    });
    if (!output.success) throw new CompiledBinaryBuildError(output.logs);
    await emitMetafileMarkdown(options);
    return output;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};
export const parseCompiledBinaryArgs = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CompiledBinaryOptions => {
  let target: string | undefined;
  let outfile = DEFAULT_OUTFILE;
  let version: string | undefined;
  let metafileMd: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error("Unexpected empty compiled binary argument.");
    }
    if (arg === "--") continue;
    if (arg === "--minify") continue;

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (
      flag !== "--target" &&
      flag !== "--outfile" &&
      flag !== "--version" &&
      flag !== "--sourcemap" &&
      flag !== "--metafile-md"
    ) {
      throw new Error(`Unknown compiled binary argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} expects a value.`);
    }
    if (inlineValue === undefined) index += 1;

    if (flag === "--sourcemap") {
      if (value !== "external") throw new Error("--sourcemap must be external.");
      continue;
    }

    if (flag === "--target") target = platformFor(value).id;
    if (flag === "--outfile") outfile = value;
    if (flag === "--version") version = value;
    if (flag === "--metafile-md") metafileMd = value;
  }

  if (metafileMd === undefined && env.LANDO_COMPILE_METAFILE === "1") {
    metafileMd = `${outfile}.metafile.md`;
  }

  return {
    ...(target === undefined ? {} : { target }),
    outfile,
    ...(version === undefined ? {} : { version }),
    ...(metafileMd === undefined ? {} : { metafileMd }),
  };
};

if (import.meta.main) {
  try {
    await buildCompiledBinary(parseCompiledBinaryArgs(Bun.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof CompiledBinaryBuildError || error instanceof CompiledBinaryVersionError)) {
      throw error;
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}
