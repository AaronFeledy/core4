/**
 * The root-owned leftovers that running lando with sudo leaves under its roots, as root creates
 * them for `root-ownership-repair-pty-live.integration.test.ts`, and checks of what became of them.
 */
import { expect } from "bun:test";
import { LANDO, scenarioRoots } from "./elevation-suite";
import type { PathFacts, Transcript } from "./fixtures/elevation/pty-driver-contract";

const WALKER = "__internal:repair-root-ownership";

export const layout = (id: string) => {
  const { root, data, cache } = scenarioRoots(id);
  return {
    root,
    dir: `${data}/setup/rootdir`,
    dirFile: `${data}/setup/rootdir/inner`,
    file: `${cache}/rootfile`,
    symlink: `${cache}/rootlink`,
    hardLink: `${cache}/hard`,
    hardLinkTarget: `/var/lib/lando-test/${id}-target`,
  };
};

/** Which leftovers root creates; the roots that exist stay landotest's. */
export type Leftovers = "file-only" | "full" | "full-with-hard-link";

export const leftovers = (id: string, kind: Leftovers, dataRoot = true): string => {
  const { data, cache } = scenarioRoots(id);
  const paths = layout(id);
  const roots = dataRoot ? `${data}/setup ${cache}` : cache;
  const steps = [
    `setpriv --reuid landotest --regid landotest --init-groups -- mkdir -p ${roots}`,
    `touch ${paths.file}`,
  ];
  if (kind !== "file-only") {
    steps.push(`mkdir ${paths.dir}`, `touch ${paths.dirFile}`, `ln -s /etc/shadow ${paths.symlink}`);
  }
  if (kind === "full-with-hard-link") {
    steps.push(
      "mkdir -p /var/lib/lando-test",
      `printf secret > ${paths.hardLinkTarget}`,
      `chmod 0640 ${paths.hardLinkTarget}`,
      `ln ${paths.hardLinkTarget} ${paths.hardLink}`,
    );
  }
  return steps.join(" && ");
};

/** The scenario's roots belong to landotest, so their owner is the one repaired files get. */
const user = (run: Transcript): PathFacts => {
  const facts = run.pathsBefore[scenarioRoots(run.id).root];
  if (facts === null || facts === undefined) throw new Error(`${run.id} has no scenario root.`);
  return facts;
};

/** The walker's argv with its `--path` targets as a set: the scan's listing order is the directory's. */
export const walkerCall = (argv: readonly string[]) => {
  const first = argv.indexOf("--path");
  const head = first === -1 ? argv : argv.slice(0, first);
  const targets = first === -1 ? [] : argv.slice(first).filter((_, index) => index % 2 === 1);
  return { head, targets: [...targets].sort() };
};
export const expectedWalkerCall = (run: Transcript, targets: readonly string[]) => {
  const { data, cache } = scenarioRoots(run.id);
  const { uid, gid } = user(run);
  return walkerCall([
    ...[LANDO, WALKER, "--uid", String(uid), "--gid", String(gid), "--root", data, "--root", cache],
    ...["--storage", `${data}/runtime/storage`, ...targets.flatMap((path) => ["--path", path])],
  ]);
};

export const unchanged = (run: Transcript, paths: readonly string[]) => {
  for (const path of paths) expect(run.paths[path], path).toEqual(run.pathsBefore[path] ?? null);
};
export const givenBack = (run: Transcript, paths: readonly string[]) => {
  const { uid, gid } = user(run);
  for (const path of paths) {
    const before = run.pathsBefore[path];
    expect(run.paths[path], path).toEqual(
      before === null || before === undefined ? null : { ...before, uid, gid },
    );
  }
};
