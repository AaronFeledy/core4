import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  NFT_MANIFEST,
  bundledLoaderDepsSatisfied,
  ensureManagedNft,
  hasUsableManagedNft,
  managedNftBinPath,
  managedNftLibDir,
  readElfNeeded,
  resolveNftHostKey,
} from "../src/nft-provision.ts";
import type { ArtifactDownload } from "../src/runtime-bundle.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("Debian nft pin verification", () => {
  test.skipIf(process.platform !== "linux" || process.env.LANDO_TEST_NFT_DEBIAN_PIN !== "1")(
    "every pinned package matches the published sha256/size and current-arch pins install a working nft",
    async () => {
      const fetched = new Map<string, Uint8Array>();
      for (const [host, packages] of Object.entries(NFT_MANIFEST.packages)) {
        for (const pkg of packages) {
          const response = await fetch(pkg.url);
          expect(response.ok, `${host} ${pkg.name} HTTP ${response.status}`).toBe(true);
          const bytes = new Uint8Array(await response.arrayBuffer());
          expect(sha256(bytes), `${host} ${pkg.name} sha256`).toBe(pkg.sha256);
          expect(bytes.byteLength, `${host} ${pkg.name} size`).toBe(pkg.sizeBytes);
          fetched.set(`${host}:${pkg.filename}`, bytes);
        }
      }

      const hostKey = resolveNftHostKey("linux", process.arch);
      expect(hostKey).toBeDefined();
      if (hostKey === undefined) return;
      const packages = NFT_MANIFEST.packages[hostKey];
      expect(packages).toBeDefined();
      if (packages === undefined) return;

      const root = await mkdtemp(join(tmpdir(), "lando-nft-debian-"));
      const runtimeBinDir = join(root, "runtime", "bin");
      const download: ArtifactDownload = (request) => {
        const bytes = fetched.get(`${hostKey}:${request.filename}`);
        if (bytes === undefined) {
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "setup",
              message: `missing downloaded pin ${request.filename}`,
              remediation: "n/a",
            }),
          );
        }
        return Effect.succeed({
          bytes,
          sha256: request.expectedSha256,
          path: join(request.directory, request.filename),
        });
      };

      try {
        await Effect.runPromise(
          ensureManagedNft({
            runtimeBinDir,
            download,
            cacheDir: join(root, "cache"),
            platform: "linux",
            arch: process.arch,
          }),
        );
        const nftPath = managedNftBinPath(runtimeBinDir);
        const libDir = managedNftLibDir(runtimeBinDir);
        expect(await hasUsableManagedNft(runtimeBinDir)).toBe(true);
        expect(await bundledLoaderDepsSatisfied(libDir)).toBe(true);
        const bundled = await readdir(libDir);
        for (const prefix of ["libedit.so", "libtinfo.so", "libbsd.so", "libmd.so"]) {
          expect(
            bundled.some((name) => name === prefix || name.startsWith(`${prefix}.`)),
            prefix,
          ).toBe(true);
        }
        const libeditName = bundled.find((name) => name.startsWith("libedit.so"));
        expect(libeditName).toBeDefined();
        if (libeditName !== undefined) {
          const needed = readElfNeeded(new Uint8Array(await readFile(join(libDir, libeditName))));
          expect(needed).toContain("libtinfo.so.6");
          expect(needed).toContain("libbsd.so.0");
        }
        const ldd = await Bun.$`env LD_LIBRARY_PATH=${libDir} ldd ${join(libDir, "nft")}`.text();
        expect(ldd).not.toMatch(/not found/iu);
        for (const soname of ["libedit.so", "libtinfo.so", "libbsd.so", "libmd.so"]) {
          const line = ldd.split("\n").find((entry) => entry.includes(soname));
          expect(line, soname).toBeDefined();
          expect(line, `${soname} resolved from bundle`).toContain(libDir);
        }
        const version = await Bun.$`${nftPath} --version`.text();
        expect(version).toMatch(/nftables/iu);
        const jsonHelp = await Bun.$`${nftPath} -j --help`.nothrow();
        const jsonText = `${jsonHelp.stdout.toString()}\n${jsonHelp.stderr.toString()}`;
        expect(jsonText).not.toMatch(/JSON output not available/iu);
        expect(jsonText).not.toMatch(/without JSON support/iu);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
