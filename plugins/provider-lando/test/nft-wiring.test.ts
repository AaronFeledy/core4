import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";

import { ensureRuntime } from "../src/ensure-runtime.ts";
import { NFT_WRAPPER_SCRIPT, hasUsableManagedNft, managedNftBinPath } from "../src/nft-provision.ts";
import { buildPodmanServiceArgs } from "../src/podman-service-args.ts";
import type { ArtifactDownload } from "../src/runtime-bundle.ts";

const pad = (value: string, length: number): string => value.padEnd(length, " ");

const makeAr = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const chunks: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const member of members) {
    const header = Buffer.from(
      `${pad(member.name, 16)}${pad("0", 12)}${pad("0", 6)}${pad("0", 6)}${pad("100644", 8)}${pad(String(member.bytes.length), 10)}\`\n`,
    );
    chunks.push(header, Buffer.from(member.bytes));
    if (member.bytes.length % 2 === 1) chunks.push(Buffer.from("\n"));
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const makeTar = (
  entries: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const BLOCK = 512;
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    Buffer.from(entry.name).copy(header, 0);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`).copy(header, 124);
    header[156] = 48;
    Buffer.from("ustar\0").copy(header, 257);
    let checksum = 0;
    header.fill(0x20, 148, 156);
    for (const byte of header) checksum += byte;
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);
    chunks.push(header, Buffer.from(entry.bytes));
    const padBytes = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (padBytes > 0) chunks.push(Buffer.alloc(padBytes));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(Buffer.concat(chunks));
};

const fakeNftScript = "#!/bin/sh\necho 'nftables v1.1.3 (test)'\n";

const makeSyntheticNftDeb = (): Uint8Array => {
  const tar = makeTar([{ name: "usr/sbin/nft", bytes: Buffer.from(fakeNftScript) }]);
  return makeAr([
    { name: "debian-binary", bytes: Buffer.from("2.0\n") },
    { name: "data.tar.gz", bytes: new Uint8Array(gzipSync(tar)) },
  ]);
};

describe("ensureRuntime nft helper", () => {
  test("provisions nft before treating a healthy linux runtime as ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-ensure-nft-"));
    const runtimeBinDir = join(root, "bin");
    const podmanBin = join(runtimeBinDir, "podman");
    const pidPath = join(root, "podman.pid");
    const spec = buildPodmanServiceArgs({
      podmanBin,
      storageDir: join(root, "storage"),
      runRoot: join(root, "run"),
      configDir: join(root, "config"),
      socketPath: join(root, "podman.sock"),
    });
    const deb = makeSyntheticNftDeb();
    const downloaded: string[] = [];
    const download: ArtifactDownload = (request) => {
      downloaded.push(request.filename);
      return Effect.succeed({
        bytes: deb,
        sha256: request.expectedSha256,
        path: join(request.directory, request.filename),
      });
    };

    try {
      await mkdir(runtimeBinDir, { recursive: true });
      await writeFile(pidPath, "4321");
      await writeFile(`${pidPath}.launch.json`, JSON.stringify({ pid: 4321, env: spec.env }));
      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi: { info: Effect.succeed({}), ping: Effect.succeed(undefined) },
          serviceRunner: {
            launch: () => Effect.fail(new Error("should not launch")),
            isAlive: () => Effect.succeed(true),
            isServiceProcess: () => Effect.succeed(true),
            terminate: () => Effect.void,
          },
          podmanBin,
          storageDir: join(root, "storage"),
          runRoot: join(root, "run"),
          configDir: join(root, "config"),
          socketPath: join(root, "podman.sock"),
          pidPath,
          nftProvision: {
            download,
            cacheDir: join(root, "nft-downloads"),
            arch: "x64",
          },
        }),
      );
      expect(downloaded.length).toBeGreaterThan(0);
      expect(await hasUsableManagedNft(runtimeBinDir)).toBe(true);
      expect(await readFile(managedNftBinPath(runtimeBinDir), "utf8")).toBe(NFT_WRAPPER_SCRIPT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
