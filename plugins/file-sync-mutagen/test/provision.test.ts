import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ToolExtractError, ToolManifestError } from "@lando/sdk/errors";
import type { ToolArtifactEntry } from "@lando/sdk/schema";

import {
  makeFakeDownloader,
  makeTarGz,
  makeZip,
  sha256Hex,
} from "../../../sdk/test/tool-provisioning/_fixtures.ts";
import {
  MUTAGEN_TOOL_MANIFEST,
  MUTAGEN_TOOL_VERSION,
  mutagenAgentInstallPath,
  mutagenHostInstallName,
  mutagenHostInstallPath,
  mutagenInstalledVersionPath,
  provisionMutagen,
  readInstalledMutagenStatus,
} from "../src/provision.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const HOST_BIN = text("#!/bin/sh\necho mutagen host\n");
const HOST_EXE = text("MZ-mutagen-host-exe");
const AGENT_AMD64 = text("mutagen-agent-linux-amd64");
const AGENT_ARM64 = text("mutagen-agent-linux-arm64");
const AGENT_ARMV7 = text("mutagen-agent-linux-armv7");
const STALE_BIN = text("stale but fingerprinted");

const NESTED_AGENTS = makeTarGz([
  { name: "linux_amd64", bytes: AGENT_AMD64 },
  { name: "linux_arm64", bytes: AGENT_ARM64 },
  { name: "linux_arm", bytes: AGENT_ARMV7 },
]);

const HOST_TARGZ = makeTarGz([
  { name: "mutagen", bytes: HOST_BIN },
  { name: "mutagen-agents.tar.gz", bytes: NESTED_AGENTS },
]);

const HOST_ZIP = makeZip([
  { name: "mutagen.exe", bytes: HOST_EXE },
  { name: "mutagen-agents.tar.gz", bytes: NESTED_AGENTS },
]);

const AGENT_GUESTS = ["linux-amd64", "linux-arm64", "linux-armv7"] as const;
const AGENT_MEMBERS: Record<(typeof AGENT_GUESTS)[number], string> = {
  "linux-amd64": "linux_amd64",
  "linux-arm64": "linux_arm64",
  "linux-armv7": "linux_arm",
};

interface Dirs {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly cleanup: () => Promise<void>;
}

const makeDirs = async (): Promise<Dirs> => {
  const root = await mkdtemp(join(tmpdir(), "lando-mutagen-provision-"));
  return {
    binDir: join(root, "bin"),
    toolDownloadsDir: join(root, "tool-downloads", "mutagen"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect);

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const opt = Cause.failureOption(exit.cause);
  if (opt._tag !== "Some") throw new Error("expected a tagged failure");
  return opt.value;
};

const patchArtifact = (key: string, entry: ToolArtifactEntry): (() => void) => {
  const artifacts = MUTAGEN_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
  const original = artifacts[key];
  artifacts[key] = entry;
  return () => {
    if (original === undefined) delete artifacts[key];
    else artifacts[key] = original;
  };
};

const patchHostArchive = (
  hostKey: string,
  archive: Uint8Array,
  archiveKind: "tar.gz" | "zip",
  options: { readonly cliMember?: string } = {},
): { readonly url: string; readonly restore: () => void } => {
  const url = `https://example.test/${hostKey}.${archiveKind === "zip" ? "zip" : "tar.gz"}`;
  const base = {
    url,
    sha256: sha256Hex(archive),
    sizeBytes: archive.byteLength,
    archive: archiveKind,
  } as const;
  const restoreFns = [
    patchArtifact(`${hostKey}/cli`, {
      ...base,
      member: options.cliMember ?? (archiveKind === "zip" ? "mutagen.exe" : "mutagen"),
      installName: archiveKind === "zip" ? "mutagen.exe" : "mutagen",
    }),
    ...AGENT_GUESTS.map((guest) =>
      patchArtifact(`${hostKey}/agent/${guest}`, {
        ...base,
        member: `mutagen-agents.tar.gz/${AGENT_MEMBERS[guest]}`,
        installName: `mutagen-agents/mutagen-agent-${guest}`,
      }),
    ),
  ];
  return {
    url,
    restore: () => {
      for (const restore of restoreFns.reverse()) restore();
    },
  };
};

const provision = (input: {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly force?: boolean;
  readonly offline?: boolean;
}) => Effect.scoped(provisionMutagen(input));

const writeFingerprint = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await writeFile(`${path}.sha256`, `${sha256Hex(bytes)}\n`, "utf-8");
};

describe("MUTAGEN_TOOL_MANIFEST", () => {
  test("decodes the canonical ToolManifest with the expected host and agent keys", () => {
    expect(MUTAGEN_TOOL_MANIFEST.schemaVersion).toBe(1);
    expect(MUTAGEN_TOOL_VERSION).toBe("v0.18.1");
    expect(Object.keys(MUTAGEN_TOOL_MANIFEST.artifacts).sort()).toEqual([
      "darwin-arm64/agent/linux-amd64",
      "darwin-arm64/agent/linux-arm64",
      "darwin-arm64/agent/linux-armv7",
      "darwin-arm64/cli",
      "darwin-x64/agent/linux-amd64",
      "darwin-x64/agent/linux-arm64",
      "darwin-x64/agent/linux-armv7",
      "darwin-x64/cli",
      "linux-arm64/agent/linux-amd64",
      "linux-arm64/agent/linux-arm64",
      "linux-arm64/agent/linux-armv7",
      "linux-arm64/cli",
      "linux-x64/agent/linux-amd64",
      "linux-x64/agent/linux-arm64",
      "linux-x64/agent/linux-armv7",
      "linux-x64/cli",
      "win32-x64/agent/linux-amd64",
      "win32-x64/agent/linux-arm64",
      "win32-x64/agent/linux-armv7",
      "win32-x64/cli",
    ]);
  });
});

describe("mutagen install paths", () => {
  test("resolve to the helper install layout under the caller-provided binDir", () => {
    expect(mutagenHostInstallName("linux")).toBe("mutagen");
    expect(mutagenHostInstallName("win32")).toBe("mutagen.exe");
    expect(mutagenHostInstallPath("/data/bin", "linux")).toBe("/data/bin/mutagen");
    expect(mutagenAgentInstallPath("/data/bin", "linux-amd64")).toBe(
      "/data/bin/mutagen-agents/mutagen-agent-linux-amd64",
    );
    expect(mutagenInstalledVersionPath("/data/bin")).toBe("/data/bin/.mutagen.version");
  });
});

describe("provisionMutagen", () => {
  test("installs host CLI plus all three agents from one shared host tar.gz", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("linux-x64", HOST_TARGZ, "tar.gz");
    dl.serve(patch.url, HOST_TARGZ);
    try {
      const exit = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(exit._tag).toBe("Success");
      expect(dl.downloadCalls()).toBe(1);
      expect(new Uint8Array(await readFile(join(dirs.binDir, "mutagen")))).toEqual(HOST_BIN);
      expect(new Uint8Array(await readFile(mutagenAgentInstallPath(dirs.binDir, "linux-amd64")))).toEqual(
        AGENT_AMD64,
      );
      expect(new Uint8Array(await readFile(mutagenAgentInstallPath(dirs.binDir, "linux-arm64")))).toEqual(
        AGENT_ARM64,
      );
      expect(new Uint8Array(await readFile(mutagenAgentInstallPath(dirs.binDir, "linux-armv7")))).toEqual(
        AGENT_ARMV7,
      );
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("installs win32 host CLI plus agents from one shared zip", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("win32-x64", HOST_ZIP, "zip");
    dl.serve(patch.url, HOST_ZIP);
    try {
      const exit = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "win32",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(exit._tag).toBe("Success");
      expect(dl.downloadCalls()).toBe(1);
      expect(new Uint8Array(await readFile(join(dirs.binDir, "mutagen.exe")))).toEqual(HOST_EXE);
      expect(new Uint8Array(await readFile(mutagenAgentInstallPath(dirs.binDir, "linux-amd64")))).toEqual(
        AGENT_AMD64,
      );
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("idempotent offline re-run skips before touching the downloader", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("linux-x64", HOST_TARGZ, "tar.gz");
    dl.serve(patch.url, HOST_TARGZ);
    try {
      const first = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );
      expect(first._tag).toBe("Success");
      expect(dl.downloadCalls()).toBe(1);

      await rm(dirs.toolDownloadsDir, { recursive: true, force: true });
      const second = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
          offline: true,
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(second._tag).toBe("Success");
      expect(dl.downloadCalls()).toBe(1);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("force re-provisions binaries even when marker and fingerprints match", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("linux-x64", HOST_TARGZ, "tar.gz");
    dl.serve(patch.url, HOST_TARGZ);
    try {
      const first = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );
      expect(first._tag).toBe("Success");

      const hostPath = mutagenHostInstallPath(dirs.binDir, "linux");
      await writeFingerprint(hostPath, STALE_BIN);
      expect((await readInstalledMutagenStatus(dirs.binDir, "linux", "x64")).isCurrent).toBe(true);

      const forced = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
          force: true,
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(forced._tag).toBe("Success");
      expect(new Uint8Array(await readFile(hostPath))).toEqual(HOST_BIN);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("unsupported host keys fail with ToolManifestError", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    try {
      const exit = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "sunos",
          arch: "sparc",
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(failure(exit)).toBeInstanceOf(ToolManifestError);
      expect(dl.downloadCalls()).toBe(0);
    } finally {
      await dirs.cleanup();
    }
  });

  test("missing archive members fail with ToolExtractError", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("linux-x64", HOST_TARGZ, "tar.gz", { cliMember: "missing-mutagen" });
    dl.serve(patch.url, HOST_TARGZ);
    try {
      const exit = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );

      expect(failure(exit)).toBeInstanceOf(ToolExtractError);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });
});

describe("readInstalledMutagenStatus", () => {
  test("requires the marker plus host and all three agent fingerprints", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const patch = patchHostArchive("linux-x64", HOST_TARGZ, "tar.gz");
    dl.serve(patch.url, HOST_TARGZ);
    try {
      const installed = await run(
        provision({
          binDir: dirs.binDir,
          toolDownloadsDir: dirs.toolDownloadsDir,
          platform: "linux",
          arch: "x64",
        }).pipe(Effect.provide(dl.layer)),
      );
      expect(installed._tag).toBe("Success");

      const current = await readInstalledMutagenStatus(dirs.binDir, "linux", "x64");
      expect(current).toEqual({ installedVersion: MUTAGEN_TOOL_VERSION, isCurrent: true });

      await rm(mutagenInstalledVersionPath(dirs.binDir), { force: true });
      const missingMarker = await readInstalledMutagenStatus(dirs.binDir, "linux", "x64");
      expect(missingMarker.installedVersion).toBeUndefined();
      expect(missingMarker.isCurrent).toBe(false);

      await writeFile(mutagenInstalledVersionPath(dirs.binDir), `${MUTAGEN_TOOL_VERSION}\n`, "utf-8");
      await rm(`${mutagenAgentInstallPath(dirs.binDir, "linux-arm64")}.sha256`, { force: true });
      expect((await readInstalledMutagenStatus(dirs.binDir, "linux", "x64")).isCurrent).toBe(false);

      await writeFile(
        `${mutagenAgentInstallPath(dirs.binDir, "linux-arm64")}.sha256`,
        `${sha256Hex(AGENT_ARM64)}\n`,
        "utf-8",
      );
      await writeFile(mutagenAgentInstallPath(dirs.binDir, "linux-arm64"), text("corrupted"));
      expect((await readInstalledMutagenStatus(dirs.binDir, "linux", "x64")).isCurrent).toBe(false);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });
});
