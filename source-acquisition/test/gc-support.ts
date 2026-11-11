import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { SourceAcquisitionError } from "../src/errors.ts";
import {
  type GcOptions,
  type LockKeysResult,
  type SourceGcReport,
  SourceGcReportSchema,
} from "../src/gc-schema.ts";
import {
  type TestSourceStore,
  disposeTestSourceStore,
  makeTestSourceStore,
  withTestSession,
} from "../src/testing.ts";
import type { SourceStore } from "../src/types.ts";
import {
  makeFakeArchiveTransport,
  makeFakeGitTransport,
  makeFakeNpmRegistry,
  makeTarGz,
  npmVersion,
  packageTarball,
  sha256Of,
  sriSha512,
} from "./support.ts";

/** Fixed virtual epoch for TestClock + entry.json utimes (ms). */
export const GC_CLOCK_NOW_MS = 1_700_000_000_000;

export const entryJsonPath = (root: string, kind: "git" | "archive", id: string): string =>
  join(root, kind, id, "entry.json");

export const entryDirPath = (root: string, kind: "git" | "archive", id: string): string =>
  join(root, kind, id);

/** Set path atime/mtime to an absolute ms timestamp (filesystem clock). */
export const setPathMtimeMs = async (path: string, mtimeMs: number): Promise<void> => {
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
};

/** Set entry.json atime/mtime to an absolute ms timestamp (filesystem clock). */
export const setEntryMtimeMs = async (
  root: string,
  kind: "git" | "archive",
  id: string,
  mtimeMs: number,
): Promise<void> => {
  await setPathMtimeMs(entryJsonPath(root, kind, id), mtimeMs);
};

/**
 * Age a filesystem path relative to the virtual GC clock.
 * Required for unparseable leftover dirs: their mtime is wall-clock, not TestClock.
 */
export const agePathRelativeToClock = async (
  path: string,
  ageMs: number,
  clockNowMs: number = GC_CLOCK_NOW_MS,
): Promise<void> => {
  await setPathMtimeMs(path, clockNowMs - ageMs);
};

export const fingerprintStore = async (root: string): Promise<ReadonlyMap<string, string>> => {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = await readdir(dir);
    names.sort();
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const info = await lstat(full);
      if (info.isDirectory()) {
        out.set(`${rel}/`, `dir:${info.mtimeMs}`);
        await walk(full, rel);
      } else {
        const body = await readFile(full);
        out.set(rel, `file:${info.mtimeMs}:${info.size}:${createHash("sha256").update(body).digest("hex")}`);
      }
    }
  };
  await walk(root, "");
  return out;
};

export const fingerprintsEqual = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

export const emptyLockKeys = (_lockfile: string): Effect.Effect<LockKeysResult> =>
  Effect.succeed({ status: "missing" });

export const okLockKeys =
  (keys: Extract<LockKeysResult, { status: "ok" }>["keys"]) =>
  (_lockfile: string): Effect.Effect<LockKeysResult> =>
    Effect.succeed({ status: "ok", keys });

export const statusLockKeys =
  (result: LockKeysResult) =>
  (_lockfile: string): Effect.Effect<LockKeysResult> =>
    Effect.succeed(result);

export const runGc = (
  store: SourceStore,
  options: GcOptions,
  clockNowMs: number = GC_CLOCK_NOW_MS,
): Promise<SourceGcReport> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(clockNowMs);
      const report = yield* store.gc(options);
      return Schema.decodeUnknownSync(SourceGcReportSchema)(report);
    }).pipe(Effect.provide(TestClock.layer())),
  );

export const findEntry = (report: SourceGcReport, kind: "git" | "archive", id: string) => {
  const hit = report.entries.find((e) => e.kind === kind && e.id === id);
  if (hit === undefined) throw new Error(`Expected ${kind}/${id} in GC report`);
  return hit;
};

export const leftoverOf = (
  report: SourceGcReport,
  kind: SourceGcReport["leftovers"][number]["kind"],
  id?: string,
): readonly [SourceGcReport["leftovers"][number], ...SourceGcReport["leftovers"][number][]] => {
  const hits = report.leftovers.filter((l) => l.kind === kind && (id === undefined || l.id === id));
  const first = hits[0];
  if (first === undefined)
    throw new Error(`Expected leftover kind=${kind}${id === undefined ? "" : ` id=${id}`}`);
  return [first, ...hits.slice(1)];
};

/** Spawn a process that exits immediately and return its dead PID (never use PID 1). */
export const reapDeadPid = async (): Promise<number> => {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  if (child.pid === undefined) throw new Error("expected child pid");
  return child.pid;
};

export interface GcFixture extends TestSourceStore {
  readonly archive: ReturnType<typeof makeFakeArchiveTransport>;
  readonly git: ReturnType<typeof makeFakeGitTransport>;
  readonly npm: ReturnType<typeof makeFakeNpmRegistry>;
}

export const makeGcFixture = async (): Promise<GcFixture> => {
  const archive = makeFakeArchiveTransport();
  const git = makeFakeGitTransport();
  const npm = makeFakeNpmRegistry();
  const fixture = await makeTestSourceStore({
    archive: archive.transport,
    git: git.transport,
    npmRegistry: npm.transport,
  });
  return { ...fixture, archive, git, npm };
};

export const disposeGcFixture = async (fixture: GcFixture): Promise<void> => {
  await disposeTestSourceStore(fixture);
};

export const publishArchive = async (
  fixture: GcFixture,
  label: string,
  body = label,
): Promise<{ sha256: string; url: string }> => {
  const bytes = makeTarGz([{ name: `${label}.txt`, bytes: new TextEncoder().encode(body) }]);
  const sha256 = sha256Of(bytes);
  const url = `https://example.test/${label}.tgz`;
  fixture.archive.set(url, bytes);
  await Effect.runPromise(
    withTestSession(fixture.store, (session) => session.acquireArchive({ url, sha256 })),
  );
  return { sha256, url };
};

export const publishGit = async (
  fixture: GcFixture,
  commit: string,
  files: Readonly<Record<string, string>> = { "readme.txt": "hi\n" },
): Promise<{ commit: string; url: string }> => {
  const url = `https://example.test/${commit.slice(0, 8)}.git`;
  fixture.git.setRef("main", commit, files);
  fixture.git.setRef(commit, commit, files);
  await Effect.runPromise(
    withTestSession(fixture.store, (session) => session.acquireGit({ url, ref: "main" })),
  );
  return { commit, url };
};

export const publishNpm = async (
  fixture: GcFixture,
  name: string,
  version: string,
  content: string,
): Promise<{ sha256: string; name: string; version: string; registry: string }> => {
  const bytes = packageTarball({ "package.json": JSON.stringify({ name, version, content }) });
  const tarball = `https://example.test/${name.replace("/", "-")}-${version}.tgz`;
  const integrity = sriSha512(bytes);
  fixture.npm.setPackument(name, npmVersion({ name, version, dist: { tarball, integrity } }));
  fixture.npm.setTarball(tarball, bytes);
  const snap = await Effect.runPromise(
    withTestSession(fixture.store, (session) => session.acquireNpm({ name, selector: version })),
  );
  if (snap.key.kind !== "archive") throw new Error("npm snapshot must be archive-keyed");
  return { sha256: snap.key.sha256, name, version, registry: snap.pin.registry };
};

export const writeInvalidEntry = async (root: string, kind: "git" | "archive", id: string): Promise<void> => {
  const dir = entryDirPath(root, kind, id);
  await mkdir(join(dir, "tree"), { recursive: true });
  await writeFile(join(dir, "tree", "x.txt"), "invalid-entry");
  await writeFile(join(dir, "entry.json"), JSON.stringify({ broken: true }));
};

export const writeLeftoverDir = async (root: string, name: string, body = "leftover"): Promise<string> => {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "payload"), body);
  return path;
};

/** Write a leftover dir and age it relative to the virtual clock (needed for unparseable names). */
export const writeAgedLeftoverDir = async (
  root: string,
  name: string,
  ageMs: number,
  body = "leftover",
): Promise<string> => {
  const path = await writeLeftoverDir(root, name, body);
  await agePathRelativeToClock(path, ageMs);
  return path;
};

export const writeLeaseFile = async (root: string, name: string, body: unknown): Promise<string> => {
  const dir = join(root, ".leases");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
};

export const ageEntryRelativeToClock = async (
  root: string,
  kind: "git" | "archive",
  id: string,
  ageMs: number,
  clockNowMs: number = GC_CLOCK_NOW_MS,
): Promise<void> => {
  await setEntryMtimeMs(root, kind, id, clockNowMs - ageMs);
};

export type { SourceAcquisitionError, SourceGcReport, GcOptions, LockKeysResult, SourceStore };
