// allow: SIZE_OK — file-local template helpers copied together for this isolated lifecycle proof.
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { uninstall as uninstallEffect } from "@lando/engine/operations/uninstall";
import type { update } from "@lando/engine/operations/update";
import type { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

type UpdateOptions = NonNullable<Parameters<typeof update>[0]>;
type UpdateChannel = NonNullable<UpdateOptions["channel"]>;
type UpdateManifestFetcher = NonNullable<UpdateOptions["fetchManifestBytes"]>;
type UpdateManifestSignatureVerifier = NonNullable<UpdateOptions["verifyManifestSignature"]>;
type UpdateChecksumSignatureVerifier = NonNullable<UpdateOptions["verifyChecksumSignature"]>;
const repoRoot = resolve(import.meta.dirname, "../../..");
const installerPath = resolve(repoRoot, "scripts/install.sh");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
export const tempRoots: string[] = [];
export const fileUrl = (path: string): string => `file://${path}`;
// Track even the fallback HOME allocated by the copied installer runner.
export const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-install-lifecycle-"));
  tempRoots.push(root);
  return root;
};
const writeExecutable = async (path: string, content: string): Promise<void> => {
  await writeFile(path, content);
  await chmod(path, 0o755);
};
export const sha256 = (bytes: Uint8Array): string => {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
};
export const createReleaseFixture = async (
  root: string,
  channel = "stable",
  options: {
    readonly binaryScript?: string;
    readonly checksum?: string;
    readonly platform?: "linux-x64" | "darwin-x64";
    readonly sumsPathStyle?: "bare" | "release";
    readonly manifestSignatureStyle?: "gpg" | "cosign";
  } = {},
) => {
  const platform = options.platform ?? "linux-x64";
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { recursive: true });
  const binaryPath = join(releaseRoot, `lando-${platform}`);
  const binary = new TextEncoder().encode(options.binaryScript ?? '#!/bin/sh\necho "lando 4.0.0-test"\n');
  await writeFile(binaryPath, binary);
  await chmod(binaryPath, 0o755);
  const sumsPath = join(releaseRoot, "SHA256SUMS");
  const hash = options.checksum ?? sha256(binary);
  const sumsLine =
    options.sumsPathStyle === "release"
      ? `${hash}  ./dist/lando-${platform}\n`
      : `${hash}  lando-${platform}\n`;
  await writeFile(sumsPath, sumsLine);
  const ascPath = join(releaseRoot, "SHA256SUMS.asc");
  await writeFile(ascPath, "fixture-gpg-signature\n");
  const cosignSigPath = join(releaseRoot, "SHA256SUMS.sig");
  await writeFile(cosignSigPath, "fixture-cosign-signature\n");
  const crtPath = join(releaseRoot, "SHA256SUMS.crt");
  await writeFile(crtPath, "fixture-cosign-certificate\n");
  const signatureUrl = options.manifestSignatureStyle === "gpg" ? fileUrl(ascPath) : fileUrl(cosignSigPath);
  const manifest = {
    channel,
    latest: "4.0.0-test",
    binaries: {
      [platform]: { url: fileUrl(binaryPath), sha256: sha256(binary), size: binary.length },
    },
    checksums: { url: fileUrl(sumsPath), signature: signatureUrl },
  };
  const channelRoot = join(root, "channels");
  await mkdir(channelRoot, { recursive: true });
  const manifestPath = join(channelRoot, `${channel}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { ascPath, binaryPath, channelRoot, cosignSigPath, crtPath, manifestPath, sumsPath };
};
export const createFakeGpg = async (root: string) => {
  const logPath = join(root, "gpg.log");
  const gpgPath = join(root, "fake-gpg.sh");
  await writeExecutable(
    gpgPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GPG_LOG"\ncase "$*" in *"--import"*) exit 0 ;; *"--homedir"*"--verify"*) exit 0 ;; *) exit 2 ;; esac\n`,
  );
  return { gpgPath, logPath };
};
const HOST_ROOT_OVERRIDES = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_INSTALL_DIR",
  "XDG_DATA_HOME",
] as const;
const hostEnvWithoutLandoRoots = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HOST_ROOT_OVERRIDES.some((override) => override === key)),
  );
export const runInstaller = async (
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(["sh", installerPath], {
    cwd: repoRoot,
    env: { ...hostEnvWithoutLandoRoots(), HOME: await makeTempRoot(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};
const encoder = new TextEncoder();
const hex = "a".repeat(64);
export const noopTelemetry = {
  enabled: false,
  record: () => Effect.void,
} satisfies typeof Telemetry.Service;
export const noopProcessRunner = {
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => {
    throw new Error("stream is not used by update manifest tests");
  },
} satisfies typeof ProcessRunner.Service;
const manifestFor = (channel: UpdateChannel) => ({
  channel,
  latest: "4.2.0",
  released: "2026-06-17T00:00:00Z",
  minimum: "4.0.0-alpha.0",
  binaries: {
    "darwin-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-x64",
      sha256: hex,
      size: 1,
    },
    "darwin-arm64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-arm64",
      sha256: hex,
      size: 1,
    },
    "linux-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-linux-x64",
      sha256: hex,
      size: 1,
    },
    "linux-arm64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-linux-arm64",
      sha256: hex,
      size: 1,
    },
    "windows-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-windows-x64.exe",
      sha256: hex,
      size: 1,
    },
  },
  checksums: {
    url: "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS",
    signature: "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS.sig",
  },
  notes: "https://github.com/lando/lando/releases/tag/v4.2.0",
});
export const manifestWithBinary = ({
  binarySha,
  binarySize,
  platform,
}: {
  readonly binarySha: string;
  readonly binarySize: number;
  readonly platform: keyof ReturnType<typeof manifestFor>["binaries"];
}) => {
  const manifest = manifestFor("stable");
  return {
    ...manifest,
    latest: "4.4.0",
    binaries: {
      ...manifest.binaries,
      [platform]: {
        ...manifest.binaries[platform],
        sha256: binarySha,
        size: binarySize,
      },
    },
  };
};
const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
export const textBytes = (value: string): Uint8Array => encoder.encode(value);
export const verifierFor = (): UpdateManifestSignatureVerifier => () => Effect.void;
export const checksumVerifierFor = (): UpdateChecksumSignatureVerifier => () => Effect.void;
export const fetcherForSelfUpdate =
  ({
    binaryBytes,
    checksumsText,
    manifest,
    seen = [],
  }: {
    readonly manifest: ReturnType<typeof manifestFor>;
    readonly binaryBytes: Uint8Array;
    readonly checksumsText: string;
    readonly seen?: string[];
  }): UpdateManifestFetcher =>
  async (url) => {
    seen.push(url);
    if (url.endsWith(".json")) return bytes(manifest);
    if (url.endsWith(".json.sig")) return textBytes("manifest-signature");
    if (url.endsWith(".json.crt")) return textBytes("manifest-certificate");
    if (url.endsWith("SHA256SUMS")) return textBytes(checksumsText);
    if (url.endsWith("SHA256SUMS.sig")) return textBytes("checksums-signature");
    if (url.endsWith("SHA256SUMS.crt")) return textBytes("checksums-certificate");
    if (Object.values(manifest.binaries).some((binary) => url === binary.url)) return binaryBytes;
    throw new Error(`unexpected fetch: ${url}`);
  };
export const uninstall = (options: Parameters<typeof uninstallEffect>[0]) =>
  uninstallEffect(options).pipe(Effect.provide(PrivateFileAccessLive));
export const sandboxUninstallIo = (root: string) => ({
  cgroupsDelegatePath: join(root, "delegate.conf"),
  shellProfilePath: join(root, ".profile"),
  socketProxyUnitPaths: [
    join(root, "lando-proxy-http.socket"),
    join(root, "lando-proxy-http.service"),
    join(root, "lando-proxy-https.socket"),
    join(root, "lando-proxy-https.service"),
  ],
  socketProxyPolkitPath: join(root, "10-lando-proxy.rules"),
});
// Unlike the template's PATH mutation, injected seams isolate concurrent tests too.
export const withoutHostRuntimes = async <T>(
  fn: (seams: typeof inertRuntimeSeams) => Promise<T>,
): Promise<T> => fn(inertRuntimeSeams);
const inertRuntimeSeams = {
  listDiscoveredApps: async () => [],
  cleanupDiscoveredApps: async () => {},
  teardownRuntimeService: async () => ({ terminated: false }),
  readManagedProviderMachine: () => ({ ownership: "absent" as const }),
  teardownProviderMachines: async () => ({ removed: false }),
  teardownHostProxySessions: async () => {},
  terminateRuntimeBinProcesses: async () => {},
  elevate: async () => {
    throw new Error("sandbox uninstall must not elevate");
  },
} satisfies Partial<NonNullable<Parameters<typeof uninstallEffect>[0]>>;
export const runCli = async (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};
