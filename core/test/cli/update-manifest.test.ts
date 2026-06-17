import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { type UpdateChannel, UpdateManifestSchema } from "@lando/sdk/schema";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import {
  type UpdateManifestFetcher,
  type UpdateManifestSignatureVerifier,
  UpdateMinimumVersionError,
  resolveUpdateManifestUrl,
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

beforeEach(async () => {
  updateStateRoot = await mkdtemp(join(tmpdir(), "lando-update-manifest-test-"));
});

afterEach(async () => {
  await rm(updateStateRoot, { recursive: true, force: true });
});

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

const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

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

const verifierFor =
  (seen: string[] = []): UpdateManifestSignatureVerifier =>
  (input) =>
    Effect.sync(() => {
      seen.push(
        [
          input.manifestUrl,
          input.signatureUrl,
          new TextDecoder().decode(input.signatureBytes),
          input.certificateUrl,
          new TextDecoder().decode(input.certificateBytes),
        ].join("|"),
      );
    });

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
    expect(updateChannelForVersion("4.0.0-development.1")).toBe("stable");
    expect(updateChannelForVersion("4.0.0-alphabet.1")).toBe("stable");
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
        dryRun: true,
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
