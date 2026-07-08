import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT } from "./build-runtime-bundle.ts";

/**
 * Runtime host keys the committed manifest must cover — one bundle entry per
 * supported host. Intel Mac (`darwin-x64`) is omitted because Podman 6 no longer
 * ships for it. CI release platform id `windows-x64` maps to manifest key
 * `win32-x64`.
 */
export const REQUIRED_RUNTIME_HOST_KEYS = ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"] as const;

export interface ManifestInvariantViolation {
  /** Host key the violation belongs to, or `"manifest"` for top-level issues. */
  readonly key: string;
  readonly message: string;
}

export interface ManifestInvariantResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<ManifestInvariantViolation>;
}

export interface CheckManifestInvariantInput {
  /** Parsed manifest JSON (validated structurally here, never schema-decoded). */
  readonly manifest: unknown;
  /** Raw contents of `plugins/provider-lando/runtime-bundle-version`. */
  readonly runtimeVersionFile: string;
  /** `owner/repo` slug the release assets MUST live under (this repository). */
  readonly expectedRepository: string;
}

/**
 * A committed manifest entry MUST pin a real, published asset. A checksum is a
 * placeholder when it is not a well-formed SHA-256, or when it is "all-zero
 * style" — the pre-release scaffolding pattern (`0000…0001`) — which we detect
 * as fewer than five non-zero hex nibbles. A genuine SHA-256 has ~60 non-zero
 * nibbles; the odds of a real digest tripping this are ~16^-60.
 */
const isPlaceholderSha256 = (sha: unknown): boolean => {
  if (typeof sha !== "string") return true;
  if (!/^[0-9a-f]{64}$/u.test(sha)) return true;
  const nonZeroNibbles = sha.replace(/0/gu, "").length;
  return nonZeroNibbles <= 4;
};

/**
 * Validate the committed runtime-bundle manifest offline using only in-repo
 * inputs (no network).
 */
export const checkRuntimeBundleManifestInvariant = (
  input: CheckManifestInvariantInput,
): ManifestInvariantResult => {
  const violations: ManifestInvariantViolation[] = [];
  const add = (key: string, message: string): void => {
    violations.push({ key, message });
  };

  const { manifest } = input;
  if (typeof manifest !== "object" || manifest === null) {
    add("manifest", "manifest is not a JSON object");
    return { ok: false, violations };
  }
  const record = manifest as Record<string, unknown>;

  if (record.schemaVersion !== 1) {
    add("manifest", `schemaVersion must be 1, got ${JSON.stringify(record.schemaVersion)}`);
  }

  const versionFile = input.runtimeVersionFile.trim();
  const runtimeVersion = record.runtimeVersion;
  if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
    add("manifest", "runtimeVersion is missing or not a string");
  } else if (runtimeVersion !== versionFile) {
    add(
      "manifest",
      `runtimeVersion "${runtimeVersion}" does not match runtime-bundle-version file "${versionFile}"`,
    );
  }

  const bundles = record.bundles;
  if (typeof bundles !== "object" || bundles === null) {
    add("manifest", "bundles is missing or not an object");
    return { ok: violations.length === 0, violations };
  }
  const bundleRecord = bundles as Record<string, unknown>;

  const required = [...REQUIRED_RUNTIME_HOST_KEYS].sort();
  const present = Object.keys(bundleRecord).sort();
  const requiredHosts = new Set<string>(required);
  for (const missing of required.filter((key) => !present.includes(key))) {
    add("manifest", `missing required host key "${missing}"`);
  }
  for (const extra of present.filter((key) => !requiredHosts.has(key))) {
    add(
      extra,
      `unexpected host key "${extra}" — the manifest must pin exactly ${required.join(", ")} (Podman 6 drops Intel Mac; Windows uses win32-x64)`,
    );
  }

  const effectiveVersion = typeof runtimeVersion === "string" ? runtimeVersion : versionFile;
  const expectedPrefix = `https://github.com/${input.expectedRepository}/releases/download/runtime-v${effectiveVersion}/`;

  for (const key of present) {
    const entry = bundleRecord[key];
    if (typeof entry !== "object" || entry === null) {
      add(key, "entry is not an object");
      continue;
    }
    const { url, sha256, filename, sizeBytes } = entry as Record<string, unknown>;

    if (typeof filename !== "string" || filename.length === 0) {
      add(key, "filename is missing or not a string");
    }

    if (typeof url !== "string") {
      add(key, "url is missing or not a string");
    } else if (!url.startsWith("https://")) {
      add(key, `url must be an HTTPS URL, got "${url}"`);
    } else if (!url.startsWith(expectedPrefix)) {
      add(key, `url "${url}" is not under this repository's release path "${expectedPrefix}"`);
    } else if (typeof filename === "string" && url !== `${expectedPrefix}${filename}`) {
      add(key, `url "${url}" does not resolve to its declared filename "${filename}"`);
    }

    if (isPlaceholderSha256(sha256)) {
      add(key, `sha256 "${String(sha256)}" is a placeholder or malformed checksum`);
    }

    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      add(key, `sizeBytes must be a positive integer, got ${JSON.stringify(sizeBytes)}`);
    }
  }

  return { ok: violations.length === 0, violations };
};

/**
 * Live verification (release path + periodic job, never per-PR): every manifest
 * URL MUST resolve over HTTPS and expose a byte length matching the recorded
 * `sizeBytes`. GitHub release asset redirects can reject HEAD, so use a ranged
 * GET and read either `Content-Range` (206) or `Content-Length` (200).
 */
export const verifyRuntimeBundleManifestUrls = async ({
  manifest,
  fetchImpl = fetch,
}: {
  readonly manifest: unknown;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<ManifestInvariantResult> => {
  const violations: ManifestInvariantViolation[] = [];

  const bundles =
    typeof manifest === "object" && manifest !== null
      ? ((manifest as Record<string, unknown>).bundles as Record<string, unknown> | undefined)
      : undefined;
  if (typeof bundles !== "object" || bundles === null) {
    return { ok: false, violations: [{ key: "manifest", message: "bundles is missing or not an object" }] };
  }

  for (const [key, entry] of Object.entries(bundles)) {
    if (typeof entry !== "object" || entry === null) {
      violations.push({ key, message: "entry is not an object" });
      continue;
    }
    const { url, sizeBytes } = entry as Record<string, unknown>;
    if (typeof url !== "string") {
      violations.push({ key, message: "url is missing or not a string" });
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
      });
    } catch (cause) {
      violations.push({ key, message: `GET ${url} failed: ${String(cause)}` });
      continue;
    }

    if (response.status !== 200 && response.status !== 206) {
      violations.push({ key, message: `GET ${url} returned ${response.status}, expected 200 or 206` });
      continue;
    }

    const contentRange = response.headers.get("content-range");
    const rangeSize = contentRange?.match(/^bytes \d+-\d+\/(\d+)$/u)?.[1];
    const observedSize = Number(rangeSize ?? response.headers.get("content-length"));
    if (!Number.isInteger(observedSize) || observedSize <= 0) {
      violations.push({
        key,
        message: `GET ${url} response has no usable Content-Range or Content-Length header`,
      });
    } else if (typeof sizeBytes === "number" && observedSize !== sizeBytes) {
      violations.push({
        key,
        message: `GET ${url} byte length ${observedSize} does not match recorded sizeBytes ${sizeBytes}`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
};

const repoRoot = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = resolve(repoRoot, "plugins/provider-lando/runtime-bundle-versions.json");
const VERSION_PATH = resolve(repoRoot, "plugins/provider-lando/runtime-bundle-version");

/** Parse an `owner/repo` slug from a GitHub SSH or HTTPS remote URL. */
export const parseGitHubRepository = (remoteUrl: string): string | undefined => {
  const trimmed = remoteUrl.trim();
  return (
    trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/u)?.[1] ??
    trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/u)?.[1]
  );
};

const gitOriginRepository = async (): Promise<string | undefined> => {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return undefined;
    return parseGitHubRepository(output);
  } catch {
    return undefined;
  }
};

/**
 * Resolve the `owner/repo` the committed manifest's release assets must live
 * under: the CI-provided `GITHUB_REPOSITORY`, else this checkout's `origin`
 * remote, else the in-repo upstream default.
 */
export const resolveManifestRepository = async (
  env: Record<string, string | undefined> = process.env,
): Promise<string> => {
  const fromEnv = env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return fromEnv;
  const fromGit = await gitOriginRepository();
  if (fromGit) return fromGit;
  return LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT;
};

const runCli = async (argv: ReadonlyArray<string>): Promise<number> => {
  const live = argv.includes("--live");
  const [manifestText, runtimeVersionFile, expectedRepository] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8"),
    readFile(VERSION_PATH, "utf8"),
    resolveManifestRepository(),
  ]);

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch (cause) {
    console.error(`[check:runtime-bundle-manifest] ${MANIFEST_PATH} is not valid JSON: ${String(cause)}`);
    return 1;
  }

  const violations: ManifestInvariantViolation[] = checkRuntimeBundleManifestInvariant({
    manifest,
    runtimeVersionFile,
    expectedRepository,
  }).violations.slice();

  if (live) {
    const liveResult = await verifyRuntimeBundleManifestUrls({ manifest });
    violations.push(...liveResult.violations);
  }

  if (violations.length > 0) {
    console.error(
      "[check:runtime-bundle-manifest] committed runtime-bundle manifest violates the committed-manifest invariant:",
    );
    for (const violation of violations) {
      console.error(`  - ${violation.key}: ${violation.message}`);
    }
    console.error(
      "Regenerate plugins/provider-lando/runtime-bundle-versions.json against published runtime-v<version> release assets (scripts/build-runtime-bundle.ts).",
    );
    return 1;
  }

  const runtimeVersion = (manifest as { runtimeVersion?: unknown }).runtimeVersion;
  console.log(
    `[check:runtime-bundle-manifest] committed manifest OK — ${live ? "offline + live" : "offline"} invariants hold (repository ${expectedRepository}, runtime-v${String(runtimeVersion)}).`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
