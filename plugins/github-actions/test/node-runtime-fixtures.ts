/**
 * Explicit opt-in verification of real, pre-provisioned upstream bytes:
 * LANDO_ACTIONS_PIN_FIXTURES=/absolute/fixtures bun run plugins/github-actions/test/node-runtime-fixtures.ts
 * No downloads, provider operations, runner processes or workflow execution.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import manifest from "../src/pins.json";

const fixtureRoot = process.env.LANDO_ACTIONS_PIN_FIXTURES;
const TIMEOUT_MS = 20_000;
const PROBE =
  "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,release:process.release.name,bun:process.versions.bun??null}))";

export const runNodeRuntimeFixtures = async () => {
  assert(
    fixtureRoot && isAbsolute(fixtureRoot),
    "Explicit LANDO_ACTIONS_PIN_FIXTURES absolute directory is required; no fixtures are downloaded.",
  );
  assert.equal(process.platform, "linux", "This opt-in execution check requires a Linux x64 fixture host.");
  assert.equal(process.arch, "x64", "This opt-in execution check requires a Linux x64 fixture host.");
  const tar = Bun.which("tar");
  assert(tar, "A host tar executable is required for explicit fixture verification.");
  const root = await realpath(fixtureRoot);
  assert((await lstat(root)).isDirectory(), "Fixture root must be a directory.");
  const scratch = await mkdtemp(join(tmpdir(), "lando-actions-node-fixture-"));
  const archives = [];
  const binaries = [];
  try {
    for (const artifact of manifest.artifacts) {
      const archive = resolve(root, artifact.filename);
      const stat = await lstat(archive);
      assert(stat.isFile() && !stat.isSymbolicLink(), "Each fixture archive must be a regular file.");
      assert.equal(stat.size, artifact.sizeBytes, `Archive size: ${artifact.filename}`);
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of Bun.file(archive).stream()) {
        size += chunk.length;
        assert(size <= artifact.sizeBytes, "Archive exceeded its pinned size while reading.");
        digest.update(chunk);
      }
      assert.equal(size, artifact.sizeBytes);
      assert.equal(digest.digest("hex"), artifact.sha256, `Archive checksum: ${artifact.filename}`);
      archives.push({ filename: artifact.filename, sha256: artifact.sha256, sizeBytes: size });
      for (const runtime of manifest.nodeRuntimes.filter((pin) => pin.artifactId === artifact.id)) {
        const extracted = join(scratch, runtime.id);
        const target = runtime.arch === "x64" ? await open(extracted, "wx", 0o700) : undefined;
        const child: Bun.Subprocess<"ignore", "pipe", "ignore"> = Bun.spawn({
          cmd: [tar, "-xOzf", archive, "--", runtime.member],
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const timeout = setTimeout(() => child.kill(), TIMEOUT_MS);
        const binaryHash = createHash("sha256");
        let binarySize = 0;
        let header = Buffer.alloc(0);
        try {
          for await (const chunk of child.stdout) {
            binarySize += chunk.length;
            assert(binarySize <= runtime.binary.sizeBytes, "Member exceeded its pinned size.");
            binaryHash.update(chunk);
            if (header.length < 20) header = Buffer.concat([header, chunk.subarray(0, 20 - header.length)]);
            if (target) await target.writeFile(chunk);
          }
          assert.equal(await child.exited, 0, "tar must successfully read the exact pinned member.");
        } finally {
          clearTimeout(timeout);
          child.kill();
          await child.exited;
          await target?.close();
        }
        assert.equal(binarySize, runtime.binary.sizeBytes);
        assert.equal(binaryHash.digest("hex"), runtime.binary.sha256, `Binary checksum: ${runtime.id}`);
        assert.deepEqual(header.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
        assert.equal(header[4], 2, "ELF class must be 64-bit.");
        assert.equal(header[5], 1, "ELF endianness must be little-endian.");
        assert.equal(header.readUInt16LE(18), runtime.binary.elfMachine);
        if (runtime.arch === "x64") {
          await chmod(extracted, 0o700);
          const probe = Bun.spawn({
            cmd: [extracted, "-e", PROBE],
            cwd: scratch,
            env: { PATH: "/unavailable" },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          });
          const probeTimeout = setTimeout(() => probe.kill(), 5_000);
          const output: Uint8Array[] = [];
          let outputBytes = 0;
          try {
            for await (const chunk of probe.stdout) {
              outputBytes += chunk.length;
              assert(outputBytes <= 1024, "Identity probe output exceeded its fixed bound.");
              output.push(chunk);
            }
            assert.equal(await probe.exited, 0, "Pinned Node identity probe must exit successfully.");
            assert.deepEqual(JSON.parse(Buffer.concat(output).toString("utf8")), {
              version: `v${runtime.nodeVersion}`,
              arch: "x64",
              platform: "linux",
              release: "node",
              bun: null,
            });
          } finally {
            clearTimeout(probeTimeout);
            probe.kill();
            await probe.exited;
          }
        }
        binaries.push({
          id: runtime.id,
          sha256: runtime.binary.sha256,
          sizeBytes: binarySize,
          elfMachine: runtime.binary.elfMachine,
          verification:
            runtime.arch === "x64" ? "absolute-Node-identity-probe" : "static-ELF-only-not-executed",
        });
      }
    }
    assert.equal(archives.length, 6);
    assert.equal(binaries.length, 8);
    assert.equal(
      binaries.filter((binary) => binary.verification === "absolute-Node-identity-probe").length,
      4,
    );
    return { archiveChecks: 6, binaryChecks: 8, x64NodeProbes: 4, arm64StaticChecks: 4, archives, binaries };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const result = await runNodeRuntimeFixtures();
  await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`);
}
