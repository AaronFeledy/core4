import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { type UpdateChannel, type UpdateManifest, UpdateManifestSchema } from "../core/src/schema/update.ts";
import { CI_PLATFORMS } from "./ci-platforms.ts";

const zeroSha256 = "0".repeat(64);
const defaultRepository = "lando-community/core4";
const defaultMinimumVersion = "4.0.0";

export interface BuildUpdateManifestInput {
  readonly version: string;
  readonly released: string;
  readonly minimum?: string;
  readonly distDir?: string;
  readonly repository?: string;
  readonly allowMissingBinaries?: boolean;
}

export interface WriteUpdateManifestInput extends BuildUpdateManifestInput {
  readonly outputPath?: string;
}

const normalizeVersion = (version: string): string => (version.startsWith("v") ? version.slice(1) : version);

export const updateChannelForReleaseVersion = (version: string): UpdateChannel => {
  const normalized = normalizeVersion(version);
  const prerelease = normalized.split("-")[1]?.split("+")[0] ?? "";
  const prereleaseParts = prerelease.split(".").filter((part) => part.length > 0);
  if (prereleaseParts.includes("alpha")) return "dev";
  if (prereleaseParts.includes("beta") || prereleaseParts.includes("rc")) return "next";
  return "stable";
};

const releaseTagForVersion = (version: string): string => `v${normalizeVersion(version)}`;

const releaseAssetName = (platformId: string): string =>
  `lando-${platformId}${platformId === "windows-x64" ? ".exe" : ""}`;

const releaseUrl = (repository: string, tag: string, artifact: string): string =>
  `https://github.com/${repository}/releases/download/${tag}/${artifact}`;

const binaryMetadata = async (
  path: string,
  allowMissingBinaries: boolean,
): Promise<{ readonly sha256: string; readonly size: number }> => {
  try {
    const [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size: stats.size };
  } catch (error) {
    if (allowMissingBinaries && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { sha256: zeroSha256, size: 0 };
    }
    throw error;
  }
};

export const buildUpdateManifest = async ({
  version,
  released,
  minimum = defaultMinimumVersion,
  distDir = "dist",
  repository = defaultRepository,
  allowMissingBinaries = false,
}: BuildUpdateManifestInput): Promise<UpdateManifest> => {
  const latest = normalizeVersion(version);
  const tag = releaseTagForVersion(version);
  const binaries = Object.fromEntries(
    await Promise.all(
      CI_PLATFORMS.map(async (platform) => {
        const artifact = releaseAssetName(platform.id);
        const metadata = await binaryMetadata(join(distDir, artifact), allowMissingBinaries);
        return [platform.id, { url: releaseUrl(repository, tag, artifact), ...metadata }] as const;
      }),
    ),
  );

  const manifest = {
    channel: updateChannelForReleaseVersion(latest),
    latest,
    released,
    minimum: normalizeVersion(minimum),
    binaries,
    checksums: {
      url: releaseUrl(repository, tag, "SHA256SUMS"),
      signature: releaseUrl(repository, tag, "SHA256SUMS.sig"),
    },
    notes: `https://github.com/${repository}/releases/tag/${tag}`,
  };

  return Schema.decodeUnknownSync(UpdateManifestSchema)(manifest, { onExcessProperty: "error" });
};

export const writeUpdateManifest = async ({
  outputPath = "dist/update-manifest.json",
  ...input
}: WriteUpdateManifestInput): Promise<UpdateManifest> => {
  const manifest = await buildUpdateManifest(input);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

const parseCliArgs = (args: ReadonlyArray<string>): WriteUpdateManifestInput => {
  let version = process.env.LANDO_RELEASE_VERSION;
  let released = process.env.LANDO_RELEASE_RELEASED ?? new Date().toISOString();
  let minimum = process.env.LANDO_RELEASE_UPDATE_MINIMUM;
  let distDir = "dist";
  let outputPath = "dist/update-manifest.json";
  let repository = process.env.GITHUB_REPOSITORY ?? defaultRepository;
  let allowMissingBinaries = process.env.LANDO_RELEASE_ALLOW_MISSING_UPDATE_BINARIES === "1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = (label: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${label} expects a value`);
      index += 1;
      return value;
    };

    if (arg === "--version") {
      version = readValue("--version");
      continue;
    }
    if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--released") {
      released = readValue("--released");
      continue;
    }
    if (arg.startsWith("--released=")) {
      released = arg.slice("--released=".length);
      continue;
    }
    if (arg === "--minimum") {
      minimum = readValue("--minimum");
      continue;
    }
    if (arg.startsWith("--minimum=")) {
      minimum = arg.slice("--minimum=".length);
      continue;
    }
    if (arg === "--dist-dir") {
      distDir = readValue("--dist-dir");
      continue;
    }
    if (arg.startsWith("--dist-dir=")) {
      distDir = arg.slice("--dist-dir=".length);
      continue;
    }
    if (arg === "--output") {
      outputPath = readValue("--output");
      continue;
    }
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
      continue;
    }
    if (arg === "--repository") {
      repository = readValue("--repository");
      continue;
    }
    if (arg.startsWith("--repository=")) {
      repository = arg.slice("--repository=".length);
      continue;
    }
    if (arg === "--allow-missing-binaries") {
      allowMissingBinaries = true;
      continue;
    }
    throw new Error(`Unknown build-update-manifest argument: ${arg}`);
  }

  if (version === undefined || version === "") throw new Error("--version is required");
  if (released === "") throw new Error("--released must not be empty");
  return { version, released, minimum, distDir, outputPath, repository, allowMissingBinaries };
};

if (import.meta.main) {
  await writeUpdateManifest(parseCliArgs(process.argv.slice(2)));
}
