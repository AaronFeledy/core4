import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import {
  CATATONIT_MANIFEST,
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
  ensureManagedCatatonit,
  runtimeInstalledVersionPath,
  verifyStaticCatatonit,
} from "../src/catatonit-provision.ts";
import type { ArtifactDownload } from "../src/runtime-bundle.ts";

test.skipIf(process.env.LANDO_TEST_CATATONIT_DEBIAN_PIN !== "1")(
  "real Debian pins install static ELF64 payloads for both architectures",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-catatonit-pins-"));
    const download: ArtifactDownload = (request) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(request.url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (request.expectedSizeBytes !== undefined) {
            expect<number | undefined>(bytes.length).toBe(request.expectedSizeBytes);
          }
          expect(sha256Hex(bytes)).toBe(request.expectedSha256);
          return { bytes, sha256: sha256Hex(bytes), path: join(request.directory, request.filename) };
        },
        catch: (cause) =>
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "test-pin",
            message: "Cannot fetch pinned Debian package",
            remediation: "Check upstream connectivity",
            cause,
          }),
      });
    try {
      for (const arch of ["x64", "arm64"] as const) {
        const runtimeBinDir = join(root, arch);
        await mkdir(runtimeBinDir, { recursive: true });
        await writeFile(runtimeInstalledVersionPath(runtimeBinDir), `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`);
        await Effect.runPromise(ensureManagedCatatonit({ runtimeBinDir, cacheDir: root, download, arch }));
        const bytes = new Uint8Array(await readFile(join(runtimeBinDir, "catatonit")));
        verifyStaticCatatonit(bytes, CATATONIT_MANIFEST.packages[arch]);
        expect(sha256Hex(bytes)).toBe(CATATONIT_MANIFEST.packages[arch].binarySha256);
        if (arch === process.arch && process.platform === "linux") {
          const proc = Bun.spawn([join(runtimeBinDir, "catatonit"), "--version"], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          expect(code).toBe(0);
          expect(stdout + stderr).toContain("0.2.1");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
