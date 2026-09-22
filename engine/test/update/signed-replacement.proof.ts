/**
 * Opt-in compiled component proof, not a default-CLI/cosign release-trust test.
 * Compile with `bun build --compile --format=esm` and run in an isolated Linux
 * sandbox with a fixture directory argument. It must contain two real Lando
 * builds (lando-old / lando-candidate), manifest.json + manifest.sig,
 * SHA256SUMS + SHA256SUMS.sig, and a separately provisioned Ed25519 trust.pem.
 * Sign exact file bytes. Never include the private key in this helper or transport.
 * Expected build stamps: 4.0.0-dev.9531 and 4.0.0-dev.9532.
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ProcessRunner, StateStore, Telemetry } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect, Either } from "effect";
import { ProcessRunnerLive } from "../../src/services/process-runner.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";
import { resolveUpdateManifestUrl } from "../../src/update/manifest.ts";
import { update } from "../../src/update/operation.ts";
import type { UpdateExecveInput } from "../../src/update/self-update.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const oldVersion = "4.0.0-dev.9531";
const newVersion = "4.0.0-dev.9532";
const fixtureArg = process.argv[2];
assert.ok(fixtureArg, "Fixture directory is required");
assert.equal(hostname(), "lando4-dev", "Run only inside the leased sandbox");
assert.ok(process.env.TMUX, "Run inside persistent tmux");
assert.equal(process.env.BUN_BE_BUN, undefined, "Launch probes must run Lando, not Bun mode");
const fixtures = resolve(fixtureArg);
const oldBytes = await Bun.file(join(fixtures, "lando-old")).bytes();
const candidateBytes = await Bun.file(join(fixtures, "lando-candidate")).bytes();
const oldHash = sha256(oldBytes);
const candidateHash = sha256(candidateBytes);
assert.notEqual(oldHash, candidateHash);
const trust = createPublicKey(await Bun.file(join(fixtures, "trust.pem")).text());
const manifest = await Bun.file(join(fixtures, "manifest.json")).bytes();
const manifestSig = await Bun.file(join(fixtures, "manifest.sig")).bytes();
const sums = await Bun.file(join(fixtures, "SHA256SUMS")).bytes();
const sumsSig = await Bun.file(join(fixtures, "SHA256SUMS.sig")).bytes();
const manifestUrl = resolveUpdateManifestUrl("dev");
const corrupted = (bytes: Uint8Array) => {
  const result = bytes.slice();
  assert.ok(result.length > 0);
  result[0] = (result[0] ?? 0) ^ 1;
  return result;
};
const verifyBytes = (bytes: Uint8Array, signature: Uint8Array) =>
  Effect.try(() => assert.ok(verify(null, bytes, trust, signature), "Ed25519 verification failed"));

const cases = [
  { name: "success", tag: undefined },
  { name: "manifest-signature", tag: "UpdateSignatureVerificationError" },
  { name: "checksum-signature", tag: "UpdateChecksumSignatureVerificationError" },
  { name: "artifact-bytes", tag: "UpdateChecksumVerificationError" },
  { name: "post-swap-launch-failure", tag: "UpdateLaunchProbeError" },
] as const;

for (const scenario of cases) {
  // Given: only this newly owned target may be replaced; state is per scenario.
  const root = await mkdtemp(join(tmpdir(), "lando-signed-component-"));
  const installed = join(root, "lando4");
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  process.env.LANDO_USER_CONF_ROOT = join(root, "config");
  try {
    await copyFile(join(fixtures, "lando-old"), installed);
    await chmod(installed, 0o755);
    // Only the recorded, digest-matched lando4 may be replaced, so seed the record
    // the installer would have written for this binary.
    const installedBytes = await Bun.file(installed).bytes();
    await mkdir(join(root, "data", "install"), { recursive: true });
    await writeFile(
      join(root, "data", "install", "record.json"),
      JSON.stringify({
        version: 1,
        data: {
          executable: {
            path: installed,
            sha256: sha256(installedBytes),
            size: installedBytes.byteLength,
            channel: "dev",
            platform: "linux-x64",
            releaseVersion: oldVersion,
          },
          shellProfiles: [],
        },
      }),
      { mode: 0o600 },
    );
    const transport = new Map<string, Uint8Array>([
      [manifestUrl, manifest],
      [`${manifestUrl}.sig`, scenario.name === "manifest-signature" ? corrupted(manifestSig) : manifestSig],
      [`${manifestUrl}.crt`, new Uint8Array()],
      ["https://fixture.invalid/SHA256SUMS", sums],
      [
        "https://fixture.invalid/SHA256SUMS.sig",
        scenario.name === "checksum-signature" ? corrupted(sumsSig) : sumsSig,
      ],
      ["https://fixture.invalid/SHA256SUMS.crt", new Uint8Array()],
      [
        "https://fixture.invalid/lando-linux-x64",
        scenario.name === "artifact-bytes" ? corrupted(candidateBytes) : candidateBytes,
      ],
    ]);
    const probes: { readonly cmd: string; readonly stdout: string; readonly exitCode: number }[] = [];
    const execCalls: UpdateExecveInput[] = [];
    const evidence = await Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* ProcessRunner;
        const store = yield* StateStore;
        const handoff = makeUpdateHandoff(store);
        const initial = yield* live.run({ cmd: installed, args: ["--version"], timeoutMs: 15_000 });
        assert.equal(initial.exitCode, 0);
        assert.ok(initial.stdout.includes(oldVersion));
        const observed: typeof ProcessRunner.Service = {
          ...live,
          run: (input) =>
            Effect.gen(function* () {
              // Fault injection changes the real target's permissions, not a fabricated process result.
              if (scenario.name === "post-swap-launch-failure" && input.cmd === installed) {
                yield* Effect.promise(() => chmod(installed, 0o644));
              }
              return yield* live.run(input).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    probes.push({ cmd: input.cmd, ...result });
                  }),
                ),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    probes.push({ cmd: input.cmd, stdout: "exec failed", exitCode: -1 });
                  }),
                ),
              );
            }),
        };
        // When: production update handles every trust/checksum/replace/handoff decision.
        const outcome = yield* update({
          only: "core",
          channel: "dev",
          currentVersion: oldVersion,
          updateStatePath: join(root, "update-state.json"),
          handoff,
          fetchManifestBytes: async (url) => {
            const bytes = transport.get(url);
            assert.ok(bytes, `Unexpected fixture request ${url}`);
            return bytes;
          },
          verifyManifestSignature: (input) => verifyBytes(input.manifestBytes, input.signatureBytes),
          verifyChecksumSignature: (input) => verifyBytes(input.checksumsBytes, input.signatureBytes),
          selfUpdate: {
            argv: [installed, "/$bunfs/root/lando.js", "update", "--only", "core"],
            env: { PATH: process.env.PATH },
            execve: (input) =>
              Effect.sync(() => {
                execCalls.push(input);
              }),
          },
        }).pipe(Effect.provideService(ProcessRunner, observed), Effect.either);
        // Then: actual bytes and executed process observations, not just planned assertions.
        const targetHash = sha256(yield* Effect.promise(() => Bun.file(installed).bytes()));
        if (scenario.tag === undefined) {
          assert.ok(Either.isRight(outcome));
          assert.equal(outcome.right.updatedCore, true);
          assert.equal(targetHash, candidateHash);
          const backupHash = sha256(yield* Effect.promise(() => Bun.file(`${installed}.bak`).bytes()));
          assert.equal(backupHash, oldHash);
          assert.equal(probes.length, 2);
          assert.notEqual(probes[0]?.cmd, installed);
          assert.equal(probes[1]?.cmd, installed);
          for (const probe of probes) {
            assert.equal(probe.exitCode, 0);
            assert.ok(probe.stdout.includes(newVersion));
          }
          assert.equal(execCalls.length, 1);
          const exec = execCalls[0];
          assert.ok(exec);
          assert.equal(exec.path, installed);
          assert.deepEqual(exec.argv, [installed, "update", "--only", "core"]);
          const token = exec.env.LANDO_UPDATE_HANDOFF_TOKEN;
          assert.ok(token);
          const receipt = yield* update({ handoff: makeUpdateHandoff(store, token) });
          assert.equal(receipt.updatedCore, true);
          assert.deepEqual(receipt.updatedPlugins, []);
          return { targetHash, backupHash, receipt, reexecArgv: exec.argv, probes };
        }
        assert.ok(Either.isLeft(outcome));
        assert.equal(outcome.left._tag, scenario.tag);
        assert.equal(targetHash, oldHash);
        assert.equal(execCalls.length, 0);
        assert.equal(probes.length, scenario.name === "post-swap-launch-failure" ? 2 : 0);
        const restored = yield* live.run({ cmd: installed, args: ["--version"], timeoutMs: 15_000 });
        assert.equal(restored.exitCode, 0);
        assert.ok(restored.stdout.includes(oldVersion));
        return { targetHash, tag: outcome.left._tag, probes, restored: restored.stdout.trim() };
      }).pipe(
        Effect.provide(ProcessRunnerLive),
        Effect.provide(StateStoreLive),
        Effect.provideService(Telemetry, { enabled: false, record: () => Effect.void }),
      ),
    );
    console.log(
      JSON.stringify({ scenario: scenario.name, status: "PASS", oldHash, candidateHash, ...evidence }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
