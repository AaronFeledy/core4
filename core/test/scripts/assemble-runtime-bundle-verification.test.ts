import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assembleBundle, parseRuntimeBundleSources } from "../../../scripts/assemble-runtime-bundle.ts";
import { buildManagedRuntimeServiceArgs } from "../../src/runtime/managed-runtime-service.ts";

const podmanBytes = new TextEncoder().encode("pinned-podman-binary");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const sourcesFor = (hostKey: "darwin-arm64" | "linux-x64") =>
  parseRuntimeBundleSources({
    schemaVersion: 1,
    runtimeVersion: "9.9.9-verification",
    bundles: {
      [hostKey]: {
        components: [
          {
            name: "fixture-engine",
            version: "6.0.0",
            url: `https://example.test/podman-${hostKey}`,
            sha256: sha256(podmanBytes),
            archive: "none",
            installName: "bin/fixture-engine",
            mode: 493,
          },
        ],
      },
    },
  });

describe("Linux runtime bundle verification", () => {
  test("verifies staged Podman with the managed-service argv before packing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-verify-"));
    const commands: Array<ReadonlyArray<string>> = [];
    let configIsDirectory = false;
    try {
      const result = await assembleBundle({
        hostKey: "linux-x64",
        sources: sourcesFor("linux-x64"),
        outDir: dir,
        fetchArtifact: async () => podmanBytes,
        verifyCommand: async (command) => {
          commands.push(command);
          const configIndex = command.indexOf("--config");
          const configPath = command[configIndex + 1];
          if (configPath !== undefined) configIsDirectory = (await stat(configPath)).isDirectory();
        },
      });

      expect(commands).toHaveLength(1);
      const command = commands[0];
      const binary = command?.[0];
      if (binary === undefined) throw new Error("verifier command requires a binary");
      const valueAfter = (flag: string): string => {
        const index = command.indexOf(flag);
        const value = command[index + 1];
        if (value === undefined) throw new Error(`verifier command requires ${flag}`);
        return value;
      };
      const socketUri = command.at(-2);
      if (socketUri === undefined || !socketUri.startsWith("unix://")) {
        throw new Error("verifier command requires a Unix socket URI");
      }
      expect(binary.endsWith("/bin/podman")).toBe(true);
      expect(command.slice(1, -1)).toEqual(
        buildManagedRuntimeServiceArgs({
          runtimeStorageDir: valueAfter("--root"),
          runtimeRunDir: valueAfter("--runroot"),
          runtimeConfigDir: valueAfter("--config"),
          runtimeBinDir: dirname(binary),
          providerSocketPath: socketUri.slice("unix://".length),
        }),
      );
      expect(command?.at(-1)).toBe("--help");
      expect(configIsDirectory).toBe(true);
      expect(await Bun.file(result.artifactPath).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an incompatible Podman before emitting an archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-remote-only-"));
    const artifactPath = join(dir, "lando-runtime-linux-x64.tar.gz");
    const verifierError = new Error("unknown flag: --root");
    try {
      let failure: unknown;
      try {
        await assembleBundle({
          hostKey: "linux-x64",
          sources: sourcesFor("linux-x64"),
          outDir: dir,
          fetchArtifact: async () => podmanBytes,
          verifyCommand: async () => {
            throw verifierError;
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("expected verifier failure");
      expect(failure.message).toMatch(/managed-service verifier.*linux-x64.*unknown flag: --root/i);
      expect(failure.cause).toBe(verifierError);
      expect(await Bun.file(artifactPath).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not run for non-Linux bundles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-asm-darwin-"));
    let verifierCalls = 0;
    try {
      const result = await assembleBundle({
        hostKey: "darwin-arm64",
        sources: sourcesFor("darwin-arm64"),
        outDir: dir,
        fetchArtifact: async () => podmanBytes,
        verifyCommand: async () => {
          verifierCalls += 1;
        },
      });

      expect(verifierCalls).toBe(0);
      expect(await Bun.file(result.artifactPath).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
