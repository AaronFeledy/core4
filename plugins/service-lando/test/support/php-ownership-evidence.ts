import { lstat, mkdir, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Exit, Schema } from "effect";

export class PhpAcceptanceError extends Schema.TaggedError<PhpAcceptanceError>()("PhpAcceptanceError", {
  phase: Schema.String,
  message: Schema.String,
}) {}

export const digest = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

type Fact = string | number | boolean | readonly string[];
// Mutable assertion journal, owned by exactly one test. Never includes raw logs or environment values.
export interface PhpEvidence {
  readonly id: string;
  readonly scenario: string;
  phase: string;
  cleanup: "not-acquired" | "pending" | "completed" | "failed";
  readonly facts: Record<string, Fact>;
}

const checkout = resolve(import.meta.dirname, "../../../..");
const git = (directory: string, ...args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: directory,
    env: { ...process.env, GIT_MASTER: "1" },
    timeout: 10_000,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new PhpAcceptanceError({ phase: "identity", message: "Unable to identify the tested checkout" });
  }
  return result.stdout;
};

export const checkoutIdentity = async (directory = checkout) => {
  const status = git(directory, "status", "--porcelain=v1", "--untracked-files=all");
  const diff = git(directory, "diff", "HEAD", "--binary");
  const paths = new TextDecoder()
    .decode(git(directory, "ls-files", "--others", "--exclude-standard", "-z"))
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = [];
  for (const path of paths) {
    const absolute = join(directory, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      untracked.push({ path, kind: "symlink", sha256: digest(await readlink(absolute)) });
    } else if (stat.isFile()) {
      const hash = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(absolute).stream()) hash.update(chunk);
      untracked.push({ path, kind: "file", mode: stat.mode & 0o777, sha256: hash.digest("hex") });
    } else {
      untracked.push({ path, kind: "special", mode: stat.mode });
    }
  }
  const untrackedJson = JSON.stringify(untracked);
  return {
    revision: new TextDecoder().decode(git(directory, "rev-parse", "HEAD")).trim(),
    dirty: status.length > 0,
    statusSha256: digest(status),
    diffSha256: digest(diff),
    untrackedSha256: digest(untrackedJson),
    sourceSha256: new Bun.CryptoHasher("sha256").update(diff).update(untrackedJson).digest("hex"),
  };
};

/** Writes only bounded observations; a passed receipt is impossible until the scope has closed. */
export const recordPhpJourney = async <E>(
  evidence: PhpEvidence,
  journey: Effect.Effect<void, E>,
  destination = process.env.LANDO_PHP_OWNERSHIP_EVIDENCE_DIR,
): Promise<void> => {
  const identity = destination === undefined ? undefined : await checkoutIdentity();
  const save = async (outcome: "running" | "passed" | "failed") => {
    if (destination === undefined) return;
    const json = JSON.stringify({ ...evidence, identity, outcome }, null, 2);
    if (Buffer.byteLength(json) > 16_384) {
      throw new PhpAcceptanceError({ phase: "evidence", message: "Receipt exceeds 16 KiB limit" });
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(join(destination, `${evidence.id}.json`), `${json}\n`, { mode: 0o600 });
  };
  await save("running");
  const exit = await Effect.runPromiseExit(journey);
  await save(Exit.isSuccess(exit) && evidence.cleanup === "completed" ? "passed" : "failed");
  if (Exit.isFailure(exit)) await Effect.runPromise(Effect.failCause(exit.cause));
  if (evidence.cleanup !== "completed") {
    throw new PhpAcceptanceError({ phase: "cleanup", message: "The owned app was not cleaned up" });
  }
};
