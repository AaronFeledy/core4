import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { HostPlatform } from "@lando/sdk/schema";
import { resolveHostKey } from "@lando/sdk/tool-provisioning";

import {
  ENGINE_ID,
  MUTAGEN_TOOL_MANIFEST,
  MUTAGEN_TOOL_VERSION,
  engine,
  manifest,
  mutagenInstalledVersionPath,
  plugin,
} from "../src/index.ts";

const currentPlatform = (): HostPlatform => {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "linux";
  }
};

const currentHostInstallPaths = (binDir: string): ReadonlyArray<string> => {
  const hostKey = resolveHostKey(currentPlatform(), process.arch);
  return Object.entries(MUTAGEN_TOOL_MANIFEST.artifacts)
    .filter(([key]) => key.startsWith(`${hostKey}/`))
    .map(([, artifact]) => join(binDir, artifact.installName));
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const runFileSyncCheck = async (userDataRoot: string) => {
  const check = plugin.doctorChecks?.find((candidate) => candidate.id === "file-sync");
  if (check === undefined) throw new Error("expected the file-sync doctor contribution");

  const reports = await Effect.runPromise(
    check.run({
      providerId: "lando",
      platform: currentPlatform(),
      env: {},
      userDataRoot,
      stateDir: undefined,
    }),
  );
  const report = reports.find((candidate) => candidate.name === "file-sync");
  if (report === undefined) throw new Error("expected a file-sync doctor report");
  return report;
};

describe("@lando/file-sync-mutagen plugin descriptor", () => {
  test("uses the manifest name", () => {
    expect(plugin.name).toBe(manifest.name);
  });

  test("contributes the manifest engine id using the existing engine layer", () => {
    expect(manifest.contributes?.fileSyncEngines).toEqual([...(plugin.fileSyncEngines?.keys() ?? [])]);
    expect(plugin.fileSyncEngines?.get(ENGINE_ID)).toBe(engine);
  });

  test("reports missing Mutagen as not installed with setup remediation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-mutagen-plugin-missing-"));
    try {
      const report = await runFileSyncCheck(dataRoot);

      expect(report).toEqual({
        name: "file-sync",
        status: "warn",
        severity: "warn",
        runtimeStatus: "not-installed",
        runtime: { running: false },
        context: {
          engineId: "mutagen",
          mutagenVersion: "not-installed",
          expectedVersion: MUTAGEN_TOOL_VERSION,
        },
        solutions: [
          {
            kind: "manual",
            description: "Run `lando setup` to download the Mutagen host CLI and agent binaries.",
            command: "lando setup",
          },
        ],
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("reports a stale installed Mutagen version as mismatched", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-mutagen-plugin-mismatch-"));
    try {
      const binDir = join(dataRoot, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(mutagenInstalledVersionPath(binDir), "v0.0.0-stale\n", "utf8");

      const report = await runFileSyncCheck(dataRoot);

      expect(report).toEqual({
        name: "file-sync",
        status: "warn",
        severity: "warn",
        runtimeStatus: "installed",
        runtime: { running: false, version: "v0.0.0-stale" },
        context: {
          engineId: "mutagen",
          mutagenVersion: "v0.0.0-stale",
          expectedVersion: MUTAGEN_TOOL_VERSION,
        },
        solutions: [
          {
            kind: "manual",
            description: "Run `lando setup` to download the Mutagen host CLI and agent binaries.",
            command: "lando setup",
          },
        ],
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("reports matching Mutagen artifacts as installed and current", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-mutagen-plugin-current-"));
    try {
      const binDir = join(dataRoot, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(mutagenInstalledVersionPath(binDir), `${MUTAGEN_TOOL_VERSION}\n`, "utf8");
      for (const installPath of currentHostInstallPaths(binDir)) {
        const bytes = new TextEncoder().encode(`fake-mutagen-binary:${installPath}`);
        await mkdir(dirname(installPath), { recursive: true });
        await writeFile(installPath, bytes);
        await writeFile(`${installPath}.sha256`, sha256Hex(bytes), "utf8");
      }

      const report = await runFileSyncCheck(dataRoot);

      expect(report).toEqual({
        name: "file-sync",
        status: "pass",
        severity: "info",
        runtimeStatus: "installed",
        runtime: { running: true, version: MUTAGEN_TOOL_VERSION },
        context: {
          engineId: "mutagen",
          mutagenVersion: MUTAGEN_TOOL_VERSION,
          expectedVersion: MUTAGEN_TOOL_VERSION,
        },
        solutions: [],
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
