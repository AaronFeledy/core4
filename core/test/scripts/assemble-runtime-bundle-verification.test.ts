import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assembleBundle, parseRuntimeBundleSources } from "../../../scripts/assemble-runtime-bundle.ts";
import { verifyLinuxPodmanPortability } from "../../../scripts/linux-podman-source-build.ts";
import { buildManagedRuntimeServiceArgs } from "../../src/runtime/managed-runtime-service.ts";

const podmanBytes = new TextEncoder().encode("pinned-podman-binary");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const lddWith = (line: string): string => `
	linux-vdso.so.1 (0x00007ffcc0000000)
	libsqlite3.so.0 => /lib/aarch64-linux-gnu/libsqlite3.so.0 (0x0000ffff00000000)
	libsystemd.so.0 => /lib/aarch64-linux-gnu/libsystemd.so.0 (0x0000ffff00000000)
	libseccomp.so.2 => /lib/aarch64-linux-gnu/libseccomp.so.2 (0x0000ffff00000000)
	libc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff00000000)
	${line}
	/lib/ld-linux-aarch64.so.1 (0x0000ffff00000000)
`;

const portableLdd = lddWith("libassuan.so.9 => /lib/aarch64-linux-gnu/libassuan.so.9 (0x0000ffff00000000)");

const expectPortabilityFailure = async (ldd: string, message: RegExp): Promise<void> => {
  let failure: unknown;
  try {
    await verifyLinuxPodmanPortability("linux-x64", "/stage", async () => ldd);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toMatch(message);
};

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
  test("accepts the reviewed Ubuntu 24.04 dynamic dependency baseline", async () => {
    const commands: Array<ReadonlyArray<string>> = [];

    await verifyLinuxPodmanPortability("linux-arm64", "/stage", async (command) => {
      commands.push(command);
      return portableLdd;
    });

    expect(commands).toEqual([["ldd", "/stage/bin/podman"]]);
  });

  test("accepts supported libassuan SONAME variants from the host gpgme closure", async () => {
    await verifyLinuxPodmanPortability("linux-x64", "/stage", async () =>
      lddWith("libassuan.so.0 => /lib/x86_64-linux-gnu/libassuan.so.0 (0x00007f0000000000)"),
    );
  });

  test("rejects resolved libsubid dependencies", async () => {
    await expectPortabilityFailure(
      lddWith("libsubid.so.4 => /lib/x86_64-linux-gnu/libsubid.so.4 (0x00007f0000000000)"),
      /libsubid\.so\.4/i,
    );
  });

  test("rejects unresolved libsubid dependencies", async () => {
    await expectPortabilityFailure(lddWith("libsubid.so.4 => not found"), /libsubid\.so\.4.*not found/i);
  });

  test("rejects generic unresolved dependencies", async () => {
    await expectPortabilityFailure(lddWith("libmissing.so.1 => not found"), /libmissing\.so\.1.*not found/i);
  });

  test("rejects empty dependency inspection output", async () => {
    await expectPortabilityFailure(" \n\t\n", /ldd.*empty/i);
  });

  test("rejects dynamic dependencies outside the reviewed baseline", async () => {
    await expectPortabilityFailure(
      lddWith("libsurprise.so.0 => /lib/x86_64-linux-gnu/libsurprise.so.0 (0x00007f0000000000)"),
      /libsurprise\.so\.0/i,
    );
  });

  test("skips dynamic dependency verification for non-Linux bundles", async () => {
    let calls = 0;

    await verifyLinuxPodmanPortability("darwin-arm64", "/stage", async () => {
      calls += 1;
      return "libsurprise.so.0 => not found";
    });

    expect(calls).toBe(0);
  });

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
        inspectCommand: async () => portableLdd,
        verifyCommand: async (command) => {
          commands.push(command);
          const configIndex = command.indexOf("--config");
          const configPath = command[configIndex + 1];
          if (configPath !== undefined) configIsDirectory = (await stat(configPath)).isDirectory();
        },
      });

      expect(commands).toHaveLength(1);
      const command = commands[0];
      if (command === undefined) throw new Error("verifier command is required");
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
      expect([...command.slice(1, -1)]).toEqual([
        ...buildManagedRuntimeServiceArgs({
          runtimeStorageDir: valueAfter("--root"),
          runtimeRunDir: valueAfter("--runroot"),
          runtimeConfigDir: valueAfter("--config"),
          runtimeBinDir: dirname(binary),
          providerSocketPath: socketUri.slice("unix://".length),
        }),
      ]);
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
          inspectCommand: async () => portableLdd,
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
