import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import type { ProcessExecError } from "@lando/sdk/errors";
import type { ToolArtifactEntry } from "@lando/sdk/schema";
import type {
  CertificateAuthorityShape,
  HostChangeApplier,
  PrivilegeSession,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { Downloader } from "@lando/sdk/services";
import { Cause, type Context, Effect, Exit, Stream } from "effect";
import { makeMkcertCertificateAuthority } from "../src/ca.ts";
import { MKCERT_TOOL_MANIFEST } from "../src/provision.ts";
import type { WindowsTrustPaths } from "../src/windows-trust.ts";
import { makeFakeDownloader, sha256Hex } from "./support/fake-downloader.ts";

export const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

export const MKCERT_BIN = text("#!/bin/sh\necho mkcert\n");

export const HOST_KEY = "linux-x64";

export const SOURCE_URL = "https://example.test/linux-x64/mkcert";

export const okResult = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

export const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const option = Cause.findErrorOption(exit.cause);
  if (option._tag !== "Some") throw new Error("expected a tagged failure");
  return option.value;
};

export interface TempDirs {
  readonly root: string;
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly cleanup: () => Promise<void>;
}

export const makeTempDirs = async (prefix: string): Promise<TempDirs> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    binDir: join(root, "bin"),
    toolDownloadsDir: join(root, "tool-downloads", "mkcert"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

export const patchArtifact = (key: string, entry: ToolArtifactEntry): (() => void) => {
  const artifacts = MKCERT_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
  const original = artifacts[key];
  artifacts[key] = entry;
  return () => {
    if (original === undefined) delete artifacts[key];
    else artifacts[key] = original;
  };
};

export const patchHostBinary = (
  hostKey: string,
  bytes: Uint8Array,
  installName: string,
): { readonly url: string; readonly restore: () => void } => {
  const url = `https://example.test/${hostKey}/mkcert`;
  const restore = patchArtifact(hostKey, {
    url,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    installName,
  });
  return { url, restore };
};

export const patchHostArtifact = (bytes: Uint8Array, hostKey: string = HOST_KEY): (() => void) => {
  const artifacts = MKCERT_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
  const original = artifacts[hostKey];
  artifacts[hostKey] = {
    url: SOURCE_URL,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    installName: hostKey.startsWith("win32") ? "mkcert.exe" : "mkcert",
  };
  return () => {
    if (original === undefined) delete artifacts[hostKey];
    else artifacts[hostKey] = original;
  };
};

export interface RunCall {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface FakeProcessRunner {
  readonly service: Context.Service.Shape<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<RunCall>;
}

export const FAKE_ROOT_PEM = "-----BEGIN CERTIFICATE-----\nfake mkcert root\n-----END CERTIFICATE-----\n";

/** Like mkcert, any run that needs a root creates one in CAROOT when it has none. */
const createRootWhenMissing = async (caRoot: string): Promise<void> => {
  const rootPath = join(caRoot, "rootCA.pem");
  const exists = await access(rootPath).then(
    () => true,
    () => false,
  );
  if (exists) return;
  await mkdir(caRoot, { recursive: true });
  await writeFile(rootPath, FAKE_ROOT_PEM);
};

export const makeFakeMkcertRunner = (options: {
  readonly caRoot: string;
  readonly installExitCode?: number;
  readonly installStderr?: string;
  /** Exit code of issuing runs; they write nothing when it is not 0. */
  readonly issueExitCode?: number;
  /** PEM material written for each issuance; placeholder text otherwise. */
  readonly issue?: { readonly certificate: string; readonly privateKey: string };
  /** Runs after each issuance writes its files, before mkcert reports success. */
  readonly afterIssue?: () => Promise<void>;
  /** Answers `brew postinstall ca-certificates`; Homebrew is absent when unset. */
  readonly brewPostinstall?: () => Promise<ProcessResult>;
  /** When set, Lando cannot start `brew` at all. */
  readonly brewSpawnError?: ProcessExecError;
  /** Runs after a successful `mkcert -install`, like the trust it adds to the system store. */
  readonly afterInstall?: () => Promise<void>;
}): FakeProcessRunner => {
  const calls: RunCall[] = [];
  const run = async (input: ProcessSpawnOptions): Promise<ProcessResult> => {
    calls.push({
      cmd: input.cmd,
      args: [...input.args],
      ...(input.env === undefined ? {} : { env: { ...input.env } }),
    });
    if (input.args[0] === "-CAROOT") return okResult(`${options.caRoot}\n`);
    if (input.args[0] === "postinstall") {
      if (options.brewPostinstall === undefined) throw new Error(`unexpected brew run: ${input.cmd}`);
      return options.brewPostinstall();
    }
    if (input.args[0] === "-install") {
      await createRootWhenMissing(input.env?.CAROOT ?? options.caRoot);
      const exitCode = options.installExitCode ?? 0;
      if (exitCode !== 0)
        return { exitCode, stdout: "", stderr: options.installStderr ?? "permission denied" };
      await options.afterInstall?.();
      return okResult("The local CA is now installed in the system trust store!\n");
    }
    const certIndex = input.args.indexOf("-cert-file");
    const keyIndex = input.args.indexOf("-key-file");
    const certFile = certIndex === -1 ? undefined : input.args[certIndex + 1];
    const keyFile = keyIndex === -1 ? undefined : input.args[keyIndex + 1];
    if (certFile === undefined || keyFile === undefined) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `unexpected mkcert invocation: ${input.args.join(" ")}`,
      };
    }
    const exitCode = options.issueExitCode ?? 0;
    if (exitCode !== 0) {
      return { exitCode, stdout: "", stderr: "mkcert failed to issue" };
    }
    await createRootWhenMissing(input.env?.CAROOT ?? options.caRoot);
    await writeFile(certFile, options.issue?.certificate ?? "-----BEGIN CERTIFICATE-----\n");
    await writeFile(keyFile, options.issue?.privateKey ?? "-----BEGIN PRIVATE KEY-----\n");
    await options.afterIssue?.();
    return okResult("");
  };

  return {
    service: {
      run: (input) => {
        const spawnError = options.brewSpawnError;
        if (input.args[0] === "postinstall" && spawnError !== undefined) {
          return Effect.sync(() => void calls.push({ cmd: input.cmd, args: [...input.args] })).pipe(
            Effect.andThen(Effect.fail(spawnError)),
          );
        }
        return Effect.promise(() => run(input));
      },
      stream: () => Stream.die(new Error("stream is not used by the mkcert certificate authority")),
      streamWithExit: () =>
        Stream.die(new Error("streamWithExit is not used by the mkcert certificate authority")),
    },
    calls: () => [...calls],
  };
};

/** A Debian-family host: its anchor directory and refresh command exist, and nothing else does. */
export const DEBIAN_ANCHOR = "/usr/local/share/ca-certificates/lando-local-ca.crt";
export const DEBIAN_REFRESH = "/usr/sbin/update-ca-certificates";
export const debianHost = (path: string): boolean =>
  path === "/usr/local/share/ca-certificates" || path === DEBIAN_REFRESH;

export interface Elevation {
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string;
}

/** The run's administrator session; `onElevate` answers each command, like the store it writes. */
export const makeFakeSession = (
  onElevate: (argv: ReadonlyArray<string>) => Promise<ProcessResult> = async () => okResult(),
): { readonly session: PrivilegeSession; readonly elevations: () => ReadonlyArray<Elevation> } => {
  const elevations: Elevation[] = [];
  return {
    session: {
      transport: "direct",
      elevate: (argv, options) =>
        Effect.promise(() => {
          const stdin = options?.stdin;
          elevations.push({
            argv: [...argv],
            ...(stdin === undefined ? {} : { stdin: new TextDecoder().decode(stdin) }),
          });
          return onElevate(argv);
        }),
    },
    elevations: () => [...elevations],
  };
};

/** Plan the authority's host changes and approve every one, as `lando setup --yes` does. */
export const approveCaChanges = (
  ca: CertificateAuthorityShape,
  session: PrivilegeSession,
  runner?: Context.Service.Shape<typeof ProcessRunner>,
): Promise<HostChangeApplier> =>
  Effect.runPromise(
    Effect.map(
      ca.planHostChanges ?? Effect.succeed([]),
      (proposals) =>
        makeHostChangeApplier({
          proposals,
          approved: new Set(proposals.map(({ change }) => change.id)),
          session,
          ...(runner === undefined ? {} : { runner }),
          redact: (value) => value,
        }).applier,
    ),
  );

export interface CaHarness {
  readonly root: string;
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly caRoot: string;
  readonly cleanup: () => Promise<void>;
}

export const makeCaHarness = async (): Promise<CaHarness> => {
  const dirs = await makeTempDirs("lando-mkcert-ca-");
  return {
    root: dirs.root,
    binDir: dirs.binDir,
    toolDownloadsDir: dirs.toolDownloadsDir,
    caRoot: join(dirs.root, "caroot"),
    cleanup: dirs.cleanup,
  };
};

export const makeCa = (
  harness: CaHarness,
  runner: FakeProcessRunner,
  overrides: {
    readonly arch?: string;
    readonly platform?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly hostTrustsPem?: (pem: string) => boolean;
    /** System bundle candidates; none exist unless a test supplies them, whatever the host has. */
    readonly linuxSystemBundles?: ReadonlyArray<string>;
    /** WSL markers and certutil.exe fallback; absent unless a test supplies them, whatever the host is. */
    readonly windowsTrustPaths?: WindowsTrustPaths;
    /** Host paths that exist; none unless a test supplies them, whatever the host has. */
    readonly exists?: (path: string) => boolean;
  } = {},
): { readonly ca: CertificateAuthorityShape; readonly downloadCalls: () => number } => {
  const downloader = makeFakeDownloader();
  downloader.serve(SOURCE_URL, MKCERT_BIN);
  const downloaderService = Effect.runSync(Effect.provide(Downloader, downloader.layer));
  return {
    ca: makeMkcertCertificateAuthority({
      binDir: harness.binDir,
      toolDownloadsDir: harness.toolDownloadsDir,
      downloader: downloaderService,
      processRunner: runner.service,
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      platform: overrides.platform ?? "linux",
      arch: overrides.arch ?? "x64",
      // No Homebrew unless a test supplies one, whatever the host has installed.
      env: overrides.env ?? { PATH: "" },
      hostTrustsPem: overrides.hostTrustsPem,
      linuxSystemBundles: overrides.linuxSystemBundles ?? [join(harness.root, "no-system-bundle.pem")],
      windowsTrustPaths: overrides.windowsTrustPaths ?? {
        interop: [join(harness.root, "no-wsl-interop")],
        certutil: join(harness.root, "no-certutil.exe"),
      },
      exists: overrides.exists ?? (() => false),
    }),
    downloadCalls: downloader.downloadCalls,
  };
};
