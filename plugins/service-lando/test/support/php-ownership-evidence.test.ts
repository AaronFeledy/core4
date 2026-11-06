import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { acquireTempAppRoot } from "./live-app-scope.ts";
import {
  PhpAcceptanceError,
  type PhpEvidence,
  checkoutIdentity,
  recordPhpJourney,
} from "./php-ownership-evidence.ts";

const Receipt = Schema.Struct({ outcome: Schema.String, cleanup: Schema.String });
const readReceipt = async (path: string) => Schema.decodeUnknownSync(Receipt)(await Bun.file(path).json());

test("fingerprints untracked source contents, not only their status paths", async () => {
  // Given: an owned Git fixture with one tracked seed and one new source file.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* acquireTempAppRoot("php-receipt-identity-");
        const git = (...args: readonly string[]) => {
          const result = Bun.spawnSync(["git", ...args], {
            cwd: directory,
            env: {
              ...process.env,
              GIT_MASTER: "1",
              GIT_AUTHOR_NAME: "Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.invalid",
              GIT_COMMITTER_NAME: "Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          return result.stdout.toString().trim();
        };
        git("init", "--quiet");
        yield* Effect.promise(() => Bun.write(join(directory, "seed.txt"), "tracked\n"));
        git("add", "seed.txt");
        const tree = git("write-tree");
        const revision = git("commit-tree", tree, "-m", "Initialize evidence fixture");
        git("update-ref", "HEAD", revision);
        const source = join(directory, "new-source.ts");
        yield* Effect.promise(() => Bun.write(source, "export const value = 1;\n"));
        const before = yield* Effect.promise(() => checkoutIdentity(directory));
        // When: the same untracked path changes without changing the tracked diff.
        yield* Effect.promise(() => Bun.write(source, "export const value = 2;\n"));
        const after = yield* Effect.promise(() => checkoutIdentity(directory));
        // Then: the full source identity distinguishes the actual tested bytes.
        expect(before.revision).toBe(revision);
        expect(after.statusSha256).toBe(before.statusSha256);
        expect(after.diffSha256).toBe(before.diffSha256);
        expect(after.untrackedSha256).not.toBe(before.untrackedSha256);
        expect(after.sourceSha256).not.toBe(before.sourceSha256);
      }),
    ),
  );
});

test("publishes passed evidence only after the resource scope closes", async () => {
  // Given: a successful body whose resource release can still observe the on-disk receipt.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* acquireTempAppRoot("php-receipt-success-");
        const evidence: PhpEvidence = {
          id: "receipt",
          scenario: "receipt-unit",
          phase: "cleanup",
          cleanup: "pending",
          facts: {},
        };
        const path = join(directory, "receipt.json");
        let outcomeDuringRelease: string | undefined;
        const journey = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                outcomeDuringRelease = (await readReceipt(path)).outcome;
                evidence.cleanup = "completed";
              }),
            );
          }),
        );
        // When
        yield* Effect.promise(() => recordPhpJourney(evidence, journey, directory));
        // Then: publishing success cannot precede resource release.
        expect(outcomeDuringRelease).toBe("running");
        expect(yield* Effect.promise(() => readReceipt(path))).toEqual({
          outcome: "passed",
          cleanup: "completed",
        });
      }),
    ),
  );
});

test("fails the test and preserves failed evidence when cleanup fails", async () => {
  // Given: the assertions succeed, but the scoped release fails.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* acquireTempAppRoot("php-receipt-failure-");
        const evidence: PhpEvidence = {
          id: "receipt",
          scenario: "receipt-unit",
          phase: "cleanup",
          cleanup: "pending",
          facts: {},
        };
        const journey = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                evidence.cleanup = "failed";
                throw new PhpAcceptanceError({ phase: "cleanup", message: "Owned resource release failed" });
              }),
            );
          }),
        );
        // When
        yield* Effect.promise(async () => {
          await expect(recordPhpJourney(evidence, journey, directory)).rejects.toThrow();
        });
        // Then: no passed receipt is left behind despite successful assertions.
        expect(yield* Effect.promise(() => readReceipt(join(directory, "receipt.json")))).toEqual({
          outcome: "failed",
          cleanup: "failed",
        });
      }),
    ),
  );
});
