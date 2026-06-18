import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { type UpdateChannel, UpdateManifestSchema } from "@lando/sdk/schema";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { buildBugReport } from "../../src/cli/bug-report.ts";
import {
  type UpdateChecksumSignatureVerifier,
  UpdateLaunchProbeError,
  type UpdateManifestFetcher,
  type UpdateManifestSignatureVerifier,
  UpdateMinimumVersionError,
  UpdatePermissionError,
  type UpdateWindowsReplacementSpawnInput,
  buildWindowsReplacementScript,
  resolveUpdateManifestUrl,
  scheduleWindowsReplacement,
  update,
  updateChannelForVersion,
} from "../../src/cli/commands/update.ts";
import { updateOptionsFromInput } from "../../src/cli/oclif/commands/meta/update.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";

const encoder = new TextEncoder();

const noopTelemetry = {
  enabled: false,
  record: () => Effect.void,
} satisfies typeof Telemetry.Service;

const noopProcessRunner = {
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => {
    throw new Error("stream is not used by update manifest tests");
  },
} satisfies typeof ProcessRunner.Service;

const hex = "a".repeat(64);
let updateStateRoot = "";
const tempRoots: string[] = [];

beforeEach(async () => {
  updateStateRoot = await mkdtemp(join(tmpdir(), "lando-update-manifest-test-"));
});

afterEach(async () => {
  await rm(updateStateRoot, { recursive: true, force: true });
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const makeTempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};

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

const manifestWithBinary = ({
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
const textBytes = (value: string): Uint8Array => encoder.encode(value);
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const fetcherForManifest =
  (manifest: ReturnType<typeof manifestFor>, seen: string[] = []): UpdateManifestFetcher =>
  async (url) => {
    seen.push(url);
    if (url.endsWith(".sig")) return encoder.encode("signature");
    if (url.endsWith(".crt")) return encoder.encode("certificate");
    return bytes(manifest);
  };

const fetcherFor = (channel: UpdateChannel, seen: string[] = []): UpdateManifestFetcher =>
  fetcherForManifest(manifestFor(channel), seen);

const verifierFor = (): UpdateManifestSignatureVerifier => () => Effect.void;

const checksumVerifierFor = (): UpdateChecksumSignatureVerifier => () => Effect.void;

const fetcherForSelfUpdate =
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

const runUpdate = (options: Parameters<typeof update>[0]) =>
  update({ updateStatePath: join(updateStateRoot, "state.json"), ...options }).pipe(
    Effect.provideService(ProcessRunner, noopProcessRunner),
    Effect.provideService(Telemetry, noopTelemetry),
  );

const failureTag = async (effect: Effect.Effect<unknown, unknown>): Promise<string | undefined> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") return undefined;
  const value = failure.value;
  return typeof value === "object" && value !== null && "_tag" in value
    ? String((value as { readonly _tag: unknown })._tag)
    : undefined;
};

const failureValue = async (effect: Effect.Effect<unknown, unknown>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

describe("update signed manifest", () => {
  test("resolves stable, next, and dev channel manifest URLs", () => {
    expect(resolveUpdateManifestUrl("stable")).toBe("https://update.lando.dev/v4/stable.json");
    expect(resolveUpdateManifestUrl("next")).toBe("https://update.lando.dev/v4/next.json");
    expect(resolveUpdateManifestUrl("dev")).toBe("https://update.lando.dev/v4/dev.json");
  });

  test("derives the default update channel from the current binary version", () => {
    expect(updateChannelForVersion("4.0.0-dev.7")).toBe("dev");
    expect(updateChannelForVersion("4.0.0-alpha.3")).toBe("dev");
    expect(updateChannelForVersion("4.0.0-next.2")).toBe("next");
    expect(updateChannelForVersion("4.0.0-beta.2")).toBe("next");
    expect(updateChannelForVersion("4.0.0-rc.1")).toBe("next");
    expect(updateChannelForVersion("v4.0.0-beta.2")).toBe("next");
    expect(updateChannelForVersion("4.0.0-development.1")).toBe("stable");
    expect(updateChannelForVersion("4.0.0-alphabet.1")).toBe("stable");
    expect(updateChannelForVersion("4.0.0-preview.alpha.1")).toBe("stable");
    expect(updateChannelForVersion("4.0.0")).toBe("stable");
  });

  test("UpdateManifestSchema validates platform entries, checksums, signatures, and channel", () => {
    const decoded = Schema.decodeUnknownSync(UpdateManifestSchema)(manifestFor("stable"), {
      onExcessProperty: "error",
    });

    expect(decoded.binaries["linux-x64"].sha256).toBe(hex);
    expect(decoded.checksums.signature).toBe(
      "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS.sig",
    );
    expect(() =>
      Schema.decodeUnknownSync(UpdateManifestSchema)({
        ...manifestFor("stable"),
        checksums: { url: "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS" },
      }),
    ).toThrow();
  });

  test("fetches the manifest plus sibling signature and certificate for each requested channel", async () => {
    for (const channel of ["stable", "next", "dev"] as const) {
      const fetched: string[] = [];
      await Effect.runPromise(
        runUpdate({
          channel,
          currentVersion: "4.0.0",
          dryRun: true,
          fetchManifestBytes: fetcherFor(channel, fetched),
          verifyManifestSignature: verifierFor(),
        }),
      );
      expect(fetched).toEqual([
        `https://update.lando.dev/v4/${channel}.json`,
        `https://update.lando.dev/v4/${channel}.json.sig`,
        `https://update.lando.dev/v4/${channel}.json.crt`,
      ]);
    }
  });

  test("uses the current binary channel when no channel flag is passed", async () => {
    const fetched: string[] = [];

    await Effect.runPromise(
      runUpdate({
        currentVersion: "4.0.0-beta.4",
        dryRun: true,
        fetchManifestBytes: fetcherFor("next", fetched),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(fetched).toEqual([
      "https://update.lando.dev/v4/next.json",
      "https://update.lando.dev/v4/next.json.sig",
      "https://update.lando.dev/v4/next.json.crt",
    ]);
  });

  test("verifies the sibling signature and certificate before parsing or trusting manifest fields", async () => {
    const order: string[] = [];
    const fetchManifestBytes: UpdateManifestFetcher = async (url) => {
      order.push(`fetch:${url}`);
      if (url.endsWith(".crt")) return encoder.encode("certificate");
      return url.endsWith(".sig") ? encoder.encode("signature") : encoder.encode("not json");
    };
    const verifyManifestSignature: UpdateManifestSignatureVerifier = () =>
      Effect.sync(() => {
        order.push("verify");
      });

    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.0.0",
        fetchManifestBytes,
        verifyManifestSignature,
      }),
    );

    expect(tag).toBe("UpdateNetworkError");
    expect(order).toEqual([
      "fetch:https://update.lando.dev/v4/stable.json",
      "fetch:https://update.lando.dev/v4/stable.json.sig",
      "fetch:https://update.lando.dev/v4/stable.json.crt",
      "verify",
    ]);
  });

  test("signature verification failure stops before manifest schema trust", async () => {
    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.0.0",
        fetchManifestBytes: async (url) =>
          url.endsWith(".sig")
            ? encoder.encode("bad")
            : encoder.encode(url.endsWith(".crt") ? "cert" : "not json"),
        verifyManifestSignature: () => Effect.fail(new Error("bad signature")),
      }),
    );

    expect(tag).toBe("UpdateSignatureVerificationError");
  });

  test("minimum blocks auto-update and carries manual remediation", async () => {
    const exit = await Effect.runPromiseExit(
      runUpdate({
        channel: "stable",
        currentVersion: "3.9.0",
        fetchManifestBytes: fetcherFor("stable"),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some" && failure.value instanceof UpdateMinimumVersionError) {
        const minimumFailure = failure.value;
        expect(minimumFailure.message).toContain("Manual update is required");
        expect(minimumFailure.remediation).toContain("official installer");
        expect(minimumFailure.remediation).toContain("GitHub Releases");
      }
    }
  });

  test("minimum blocks prerelease current binaries against release minimums", async () => {
    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.0.0-beta.1",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), minimum: "4.0.0" }),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdateMinimumVersionError");
  });

  test("minimum checks strip an optional v version prefix", async () => {
    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "v4.0.0-beta.1",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), minimum: "4.0.0" }),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdateMinimumVersionError");
  });

  test("minimum follows SemVer prerelease precedence", async () => {
    const cases = [
      { currentVersion: "4.0.0-alpha.1", minimum: "4.0.0-alpha.2", allowed: false },
      { currentVersion: "4.0.0-alpha.10", minimum: "4.0.0-alpha.2", allowed: true },
      { currentVersion: "4.0.0-alpha.1", minimum: "4.0.0-alpha.beta", allowed: false },
      { currentVersion: "4.0.0-alpha.beta", minimum: "4.0.0-alpha.1", allowed: true },
      { currentVersion: "4.0.0-alpha.1", minimum: "4.0.0-alpha.1.1", allowed: false },
      { currentVersion: "4.0.0-alpha.1.1", minimum: "4.0.0-alpha.1", allowed: true },
      { currentVersion: "4.0.0-beta.1", minimum: "4.0.0-alpha.9", allowed: true },
      { currentVersion: "4.0.0-rc.1", minimum: "4.0.0-beta.9", allowed: true },
      { currentVersion: "4.0.0", minimum: "4.0.0-rc.9", allowed: true },
      { currentVersion: "4.0.0-alpha.1+build.2", minimum: "4.0.0-alpha.1", allowed: true },
      { currentVersion: "4.0.0+build.2", minimum: "4.0.0+build.1", allowed: true },
    ];

    for (const { allowed, currentVersion, minimum } of cases) {
      const tag = await failureTag(
        runUpdate({
          channel: "stable",
          currentVersion,
          dryRun: true,
          fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), minimum }),
          verifyManifestSignature: verifierFor(),
        }),
      );

      expect({ currentVersion, minimum, tag }).toEqual({
        currentVersion,
        minimum,
        tag: allowed ? undefined : "UpdateMinimumVersionError",
      });
    }
  });

  test("refuses signed manifests that would downgrade the current binary", async () => {
    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.3.0",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.2.0" }),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdateDowngradeError");
  });

  test("allows equal and newer signed manifest versions", async () => {
    for (const latest of ["4.2.0", "4.2.1", "4.3.0-beta.1"] as const) {
      await Effect.runPromise(
        runUpdate({
          channel: "stable",
          currentVersion: "4.2.0",
          dryRun: true,
          fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest }),
          verifyManifestSignature: verifierFor(),
        }),
      );
    }
  });

  test("refuses signed manifest replay after a newer channel manifest was observed", async () => {
    const updateStatePath = join(updateStateRoot, "replay-state.json");

    await Effect.runPromise(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: false,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.4.0" }),
        updateStatePath,
        verifyManifestSignature: verifierFor(),
      }),
    );

    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.3.0" }),
        updateStatePath,
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdateManifestReplayError");
  });

  test("dry-run verifies the signed manifest without persisting replay state", async () => {
    const updateStatePath = join(updateStateRoot, "dry-run-state.json");

    const result = await Effect.runPromise(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.4.0" }),
        updateStatePath,
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(result.updatedCore).toBe(false);
    await expect(readFile(updateStatePath, "utf8")).rejects.toThrow();
  });

  test("normal update verification persists replay state and reports core update intent", async () => {
    const updateStatePath = join(updateStateRoot, "normal-state.json");

    const result = await Effect.runPromise(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: false,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.4.0" }),
        updateStatePath,
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(result.updatedCore).toBe(true);
    expect(JSON.parse(await readFile(updateStatePath, "utf8"))).toEqual({ stable: { latest: "4.4.0" } });
  });

  test("normal update verification preserves the previous failure while refreshing replay state", async () => {
    const updateStatePath = join(updateStateRoot, "normal-state-with-failure.json");
    await writeFile(
      updateStatePath,
      `${JSON.stringify(
        {
          stable: {
            latest: "4.3.0",
            lastFailure: {
              category: "launch_probe_failure",
              targetVersion: "4.3.0",
              platform: "linux-x64",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await Effect.runPromise(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: false,
        fetchManifestBytes: fetcherForManifest({ ...manifestFor("stable"), latest: "4.4.0" }),
        updateStatePath,
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(result.updatedCore).toBe(true);
    expect(JSON.parse(await readFile(updateStatePath, "utf8"))).toEqual({
      stable: {
        latest: "4.4.0",
        lastFailure: {
          category: "launch_probe_failure",
          targetVersion: "4.3.0",
          platform: "linux-x64",
        },
      },
    });
  });

  test("POSIX self-update replaces the binary atomically and re-execs with preserved argv and env", async () => {
    const root = await makeTempRoot("lando-self-update-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");
    await chmod(executablePath, 0o755);

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const probeCommands: string[] = [];
    const execs: Array<{
      readonly path: string;
      readonly argv: ReadonlyArray<string>;
      readonly env: Record<string, string>;
    }> = [];
    const processRunner = {
      run: (input: Parameters<typeof noopProcessRunner.run>[0]) =>
        Effect.sync(() => {
          probeCommands.push(input.cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const result = await Effect.runPromise(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          argv: ["/previous/lando", "update", "--channel=stable"],
          env: { PATH: "/usr/bin", LANDO_CHANNEL: "stable" },
          execve: (input) =>
            Effect.sync(() => {
              execs.push(input);
            }),
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(result).toEqual({ updatedCore: true, updatedPlugins: [] });
    expect(await readFile(executablePath, "utf8")).toBe("new-binary");
    expect(await readFile(`${executablePath}.bak`, "utf8")).toBe("old-binary");
    expect(probeCommands).toHaveLength(2);
    expect(dirname(dirname(probeCommands[0] ?? ""))).toBe(root);
    expect(basename(dirname(probeCommands[0] ?? ""))).toStartWith(".lando-update-");
    expect(probeCommands[1]).toBe(executablePath);
    expect(execs).toEqual([
      {
        path: executablePath,
        argv: [executablePath, "update", "--channel=stable"],
        env: { PATH: "/usr/bin", LANDO_CHANNEL: "stable" },
      },
    ]);
  });

  test("POSIX self-update drops Bun's compiled entrypoint from re-exec argv", async () => {
    const root = await makeTempRoot("lando-self-update-bunfs-argv-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");
    await chmod(executablePath, 0o755);

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const execs: ReadonlyArray<string>[] = [];

    await Effect.runPromise(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          argv: [executablePath, "/$bunfs/root/lando", "update", "--channel", "stable"],
          env: {},
          execve: (input) =>
            Effect.sync(() => {
              execs.push(input.argv);
            }),
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, noopProcessRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(execs).toEqual([[executablePath, "update", "--channel", "stable"]]);
  });

  test("Windows self-update schedules replacement without overwriting the running exe", async () => {
    const root = await makeTempRoot("lando-self-update-windows-");
    const executablePath = join(root, "lando.exe");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-windows-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "windows-x64",
    });
    const probes: string[] = [];
    const renames: Array<readonly [string, string]> = [];
    const replacements: Array<{
      readonly executablePath: string;
      readonly stagedBinaryPath: string;
      readonly backupPath: string;
      readonly argv: ReadonlyArray<string>;
      readonly env: Record<string, string>;
      readonly manualFallback: string;
    }> = [];
    const processRunner = {
      run: (input: Parameters<typeof noopProcessRunner.run>[0]) =>
        Effect.sync(() => {
          probes.push(input.cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const result = await Effect.runPromise(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-windows-x64.exe\n`,
        }),
        selfUpdate: {
          executablePath,
          platform: "win32",
          arch: "x64",
          argv: [executablePath, "update", "--channel=stable"],
          env: { Path: "C:\\Windows" },
          rename: async (from, to) => {
            renames.push([from, to]);
            await rename(from, to);
          },
          replaceWindows: (input) =>
            Effect.sync(() => {
              replacements.push(input);
            }),
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(result).toEqual({ updatedCore: true, updatedPlugins: [] });
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    expect(renames).toEqual([]);
    expect(probes).toHaveLength(1);
    expect(dirname(dirname(probes[0] ?? ""))).toBe(root);
    expect(replacements).toHaveLength(1);
    const replacement = replacements[0];
    expect(replacement?.executablePath).toBe(executablePath);
    expect(replacement?.backupPath).toBe(`${executablePath}.bak`);
    expect(replacement?.argv).toEqual([executablePath, "update", "--channel=stable"]);
    expect(replacement?.env).toEqual({ Path: "C:\\Windows" });
    expect(replacement?.manualFallback).toContain("Close every running Lando process");
    expect(replacement?.manualFallback).toContain("lando.exe.bak");
    expect(replacement?.stagedBinaryPath).not.toBe(executablePath);
    expect(await readFile(replacement?.stagedBinaryPath ?? "", "utf8")).toBe("new-windows-binary");
  });

  test("Windows self-update reports manual fallback instructions when replacement scheduling fails", async () => {
    const root = await makeTempRoot("lando-self-update-windows-fallback-");
    const executablePath = join(root, "lando.exe");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-windows-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "windows-x64",
    });

    const failure = await failureValue(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-windows-x64.exe\n`,
        }),
        selfUpdate: {
          executablePath,
          platform: "win32",
          arch: "x64",
          replaceWindows: () =>
            Effect.fail(new Error("CreateProcess failed for C:\\Users\\Alice\\lando.exe")),
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(failure).toBeInstanceOf(UpdatePermissionError);
    if (failure instanceof UpdatePermissionError) {
      expect(failure.message).toContain("Failed to schedule Windows Lando replacement");
      expect(failure.remediation).toContain("Close every running Lando process");
      expect(failure.remediation).toContain("lando.exe.bak");
      const report = buildBugReport({
        error: failure,
        context: { commandId: "meta:update", cacheRoot: root },
      });
      expect(report.body).not.toContain("Alice");
      expect(report.remediation).toContain("Close every running Lando process");
      expect(report.remediation).toContain(executablePath);
    }
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
  });

  test("Windows replacement helper waits for the running exe lock before swapping", () => {
    const script = buildWindowsReplacementScript({
      executablePath: "C:\\Lando\\lando.exe",
      stagedBinaryPath: "C:\\Lando\\.lando-update-abc\\lando.exe",
      backupPath: "C:\\Lando\\lando.exe.bak",
      attemptedVersion: "4.4.0",
      argv: ["C:\\Lando\\lando.exe", "update", "--channel=stable"],
      env: { Path: "C:\\Windows" },
      manualFallback: "fallback",
    });

    expect(script).toContain(
      [
        ":wait",
        'move /Y "%TARGET%" "%BACKUP%" >nul 2>nul',
        "if not errorlevel 1 goto install",
        "timeout /t 1 /nobreak >nul 2>nul",
        "goto wait",
        ":install",
      ].join("\r\n"),
    );
    expect(script).not.toContain("if errorlevel 1 exit /b 1\r\n:install");
    expect(script).toContain('move /Y "%CANDIDATE%" "%TARGET%" >nul 2>nul');
    expect(script).toContain('move /Y "%BACKUP%" "%TARGET%" >nul 2>nul');
    expect(script).toContain('start "" "%TARGET%" "update" "--channel=stable"');
  });

  test("Windows replacement scheduler detaches the helper so the running exe can exit", async () => {
    const root = await makeTempRoot("lando-self-update-windows-scheduler-");
    const stagedBinaryPath = join(root, ".lando-update-abc", "lando.exe");
    await mkdir(dirname(stagedBinaryPath), { recursive: true });
    await writeFile(stagedBinaryPath, "new-windows-binary");
    const spawns: UpdateWindowsReplacementSpawnInput[] = [];

    await Effect.runPromise(
      scheduleWindowsReplacement(
        {
          executablePath: join(root, "lando.exe"),
          stagedBinaryPath,
          backupPath: join(root, "lando.exe.bak"),
          attemptedVersion: "4.4.0",
          argv: [join(root, "lando.exe"), "update"],
          env: {},
          manualFallback: "fallback",
        },
        (input) => {
          spawns.push(input);
        },
      ),
    );

    expect(spawns).toEqual([
      {
        cmd: ["cmd.exe", "/d", "/s", "/c", join(root, ".lando-update-abc", "replace-lando.cmd")],
        cwd: join(root, ".lando-update-abc"),
        detached: true,
      },
    ]);
    expect(await readFile(join(root, ".lando-update-abc", "replace-lando.cmd"), "utf8")).toContain(
      "goto wait",
    );
  });

  test("POSIX self-update fails before probe or rename when the binary checksum does not match", async () => {
    const root = await makeTempRoot("lando-self-update-checksum-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("tampered-binary");
    const manifest = manifestWithBinary({
      binarySha: "b".repeat(64),
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const probeCommands: string[] = [];
    const processRunner = {
      run: (input: Parameters<typeof noopProcessRunner.run>[0]) =>
        Effect.sync(() => {
          probeCommands.push(input.cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const tag = await failureTag(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${"a".repeat(64)}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: { executablePath, execve: () => Effect.void },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(tag).toBe("UpdateChecksumVerificationError");
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    await expect(readFile(`${executablePath}.bak`, "utf8")).rejects.toThrow();
    expect(probeCommands).toEqual([]);
  });

  test("POSIX self-update fails before probe or rename when checksum signature verification fails", async () => {
    const root = await makeTempRoot("lando-self-update-signature-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const probeCommands: string[] = [];
    const processRunner = {
      run: (input: Parameters<typeof noopProcessRunner.run>[0]) =>
        Effect.sync(() => {
          probeCommands.push(input.cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const tag = await failureTag(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: { executablePath, execve: () => Effect.void },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: () => Effect.fail(new Error("bad signature")),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(tag).toBe("UpdateChecksumSignatureVerificationError");
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    await expect(readFile(`${executablePath}.bak`, "utf8")).rejects.toThrow();
    expect(probeCommands).toEqual([]);
  });

  test("POSIX self-update restores the backup when installing the probed binary fails", async () => {
    const root = await makeTempRoot("lando-self-update-rename-rollback-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const renames: Array<readonly [string, string]> = [];

    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          execve: () => Effect.void,
          rename: async (from, to) => {
            renames.push([from, to]);
            if (to === executablePath && renames.length === 2) throw new Error("install rename failed");
            await rename(from, to);
          },
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdatePermissionError");
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    await expect(readFile(`${executablePath}.bak`, "utf8")).rejects.toThrow();
    expect(renames.map(([, to]) => to)).toEqual([`${executablePath}.bak`, executablePath, executablePath]);
  });

  test("POSIX self-update restores the backup when re-exec fails after replacement", async () => {
    const root = await makeTempRoot("lando-self-update-exec-rollback-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });

    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          execve: () => Effect.fail(new Error("execve failed")),
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdatePermissionError");
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    await expect(readFile(`${executablePath}.bak`, "utf8")).rejects.toThrow();
  });

  test("POSIX self-update restores the backup when the replaced binary fails its launch probe", async () => {
    const root = await makeTempRoot("lando-self-update-probe-rollback-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    const probes: string[] = [];
    const execs: string[] = [];
    const updateStatePath = join(root, "state.json");
    const processRunner = {
      run: (input: Parameters<typeof noopProcessRunner.run>[0]) =>
        Effect.sync(() => {
          probes.push(input.cmd);
          return probes.length === 1
            ? { exitCode: 0, stdout: "", stderr: "" }
            : {
                exitCode: 126,
                stdout: "hello from /home/alice and https://example.invalid/build",
                stderr: "contact alice@example.invalid with TOKEN=secret",
              };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const failure = await failureValue(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          execve: (input) =>
            Effect.sync(() => {
              execs.push(input.path);
            }),
        },
        updateStatePath,
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(failure).toBeInstanceOf(UpdateLaunchProbeError);
    if (failure instanceof UpdateLaunchProbeError) {
      expect(failure.platform).toBe(`${process.platform}-${process.arch}`);
      expect(failure.attemptedVersion).toBe("4.4.0");
      expect(failure.probeCommand).toContain("--version");
      expect(failure.outputSummary).toContain("[path]");
      expect(failure.outputSummary).toContain("[url]");
      expect(failure.outputSummary).not.toContain("alice");
      expect(failure.outputSummary).not.toContain("example.invalid");
      const report = buildBugReport({
        error: failure,
        context: { commandId: "meta:update", cacheRoot: root },
      });
      expect(report.body).not.toContain(root);
      expect(report.extra).toContainEqual(["attemptedVersion", "4.4.0"]);
      expect(report.extra.some(([key]) => key === "outputSummary")).toBe(true);
    }
    expect(await readFile(executablePath, "utf8")).toBe("old-binary");
    await expect(readFile(`${executablePath}.bak`, "utf8")).rejects.toThrow();
    expect(execs).toEqual([]);
    expect(probes).toHaveLength(2);
    const updateState = JSON.parse(await readFile(updateStatePath, "utf8"));
    expect(updateState).toEqual({
      stable: {
        latest: "4.4.0",
        lastFailure: {
          category: "launch_probe_failure",
          targetVersion: "4.4.0",
          platform: `${process.platform}-${process.arch}`,
        },
      },
    });
    expect(JSON.stringify(updateState)).not.toContain(root);
    expect(JSON.stringify(updateState)).not.toContain("alice");
  });

  test("POSIX self-update reports rollback failure without hiding the launch probe error", async () => {
    const root = await makeTempRoot("lando-self-update-probe-rollback-fail-");
    const executablePath = join(root, "lando");
    await writeFile(executablePath, "old-binary");

    const binaryBytes = textBytes("new-binary");
    const binarySha = sha256(binaryBytes);
    const manifest = manifestWithBinary({
      binarySha,
      binarySize: binaryBytes.byteLength,
      platform: "linux-x64",
    });
    let probeCount = 0;
    const processRunner = {
      run: () =>
        Effect.sync(() => {
          probeCount += 1;
          return probeCount === 1
            ? { exitCode: 0, stdout: "", stderr: "" }
            : { exitCode: 126, stdout: "", stderr: "broken loader" };
        }),
      stream: noopProcessRunner.stream,
    } satisfies typeof ProcessRunner.Service;

    const failure = await failureValue(
      update({
        channel: "stable",
        currentVersion: "4.2.0",
        fetchManifestBytes: fetcherForSelfUpdate({
          manifest,
          binaryBytes,
          checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
        }),
        selfUpdate: {
          executablePath,
          execve: () => Effect.void,
          rename: async (from, to) => {
            if (from === `${executablePath}.bak` && to === executablePath) {
              throw new Error("rollback rename failed at /home/alice/lando");
            }
            await rename(from, to);
          },
        },
        updateStatePath: join(root, "state.json"),
        verifyChecksumSignature: checksumVerifierFor(),
        verifyManifestSignature: verifierFor(),
      }).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.provideService(Telemetry, noopTelemetry),
      ),
    );

    expect(failure).toBeInstanceOf(UpdateLaunchProbeError);
    if (failure instanceof UpdateLaunchProbeError) {
      expect(failure.outputSummary).toContain("broken loader");
      expect(failure.rollbackFailure).toContain("rollback rename failed");
      expect(failure.rollbackFailure).not.toContain("/home/alice");
    }
    expect(await readFile(executablePath, "utf8")).toBe("new-binary");
    expect(await readFile(`${executablePath}.bak`, "utf8")).toBe("old-binary");
  });

  test("rejects placeholder binary entries after signed manifest verification", async () => {
    const tag = await failureTag(
      runUpdate({
        channel: "stable",
        currentVersion: "4.2.0",
        dryRun: true,
        fetchManifestBytes: fetcherForManifest({
          ...manifestFor("stable"),
          binaries: Object.fromEntries(
            Object.entries(manifestFor("stable").binaries).map(([platformId, binary]) => [
              platformId,
              { ...binary, sha256: "0".repeat(64), size: 0 },
            ]),
          ) as ReturnType<typeof manifestFor>["binaries"],
        }),
        verifyManifestSignature: verifierFor(),
      }),
    );

    expect(tag).toBe("UpdateNetworkError");
  });

  test("source and compiled input helpers map update flags identically", () => {
    expect(updateOptionsFromInput({ flags: { channel: "next", "dry-run": true } })).toEqual({
      channel: "next",
      dryRun: true,
    });
    expect(updateOptionsFromInput({ flags: { "dry-run": true } })).toEqual({ dryRun: true });
    expect(
      updateOptionsFromInput(compiledCommandInputFromArgv("meta:update", ["--channel=dev", "--dry-run"])),
    ).toEqual({
      channel: "dev",
      dryRun: true,
    });
  });
});
