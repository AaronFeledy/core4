import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepairHost, RepairRequest } from "../../src/host/root-ownership-repair.ts";
import { parseRepairArgs, repairArgv, runRepairCli } from "../../src/host/root-ownership-repair-cli.ts";

const linux = test.skipIf(
  process.platform !== "linux" || process.getuid?.() === 0 || process.getgid?.() === 0,
);
const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

const fixture = () => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "lando-ownership-"));
  tempDirs.push(home);
  const root = join(home, "data");
  const target = join(root, "target");
  const storage = join(target, "storage");
  fs.mkdirSync(storage, { recursive: true });
  const changed: Array<{ path: string; uid: number; gid: number }> = [];
  const host: RepairHost = {
    euid: 0,
    fromUid: uid,
    env: { SUDO_UID: String(uid), SUDO_GID: String(gid) },
    platform: "linux",
    now: () => 0,
    homeOf: () => home,
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    lstatSync: (path) => fs.lstatSync(path, { bigint: true }),
    fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
    statfsSync: fs.statfsSync,
    readdirSync: (path) => fs.readdirSync(path, { encoding: "buffer" }),
    fchownSync: (fd, uid, gid) => {
      changed.push({ path: fs.readlinkSync(`/proc/self/fd/${fd}`), uid, gid });
    },
  };
  const request: RepairRequest = { uid, gid, roots: [root], storage, paths: [target] };
  return { home, root, target, storage, uid, gid, host, request, changed };
};

const run = (request: RepairRequest, host: RepairHost) => {
  const lines: string[] = [];
  const code = runRepairCli(
    repairArgv({ ...request, invocation: [] }).slice(1),
    (line) => lines.push(line),
    host,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]?.endsWith("\n")).toBe(true);
  const report: unknown = JSON.parse(lines.join(""));
  return { code, report };
};

linux("repairs only eligible entries and never opens or descends through symlinks", () => {
  // Given
  const { home, target, storage, request, host, changed, uid, gid } = fixture();
  const outside = join(home, "outside");
  fs.mkdirSync(outside);
  const sentinel = join(outside, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  const links = [join(target, "linked-file"), join(target, "linked-dir")] as const;
  fs.symlinkSync(sentinel, links[0]);
  fs.symlinkSync(outside, links[1]);
  const plain = join(target, "plain");
  fs.writeFileSync(plain, "");
  fs.writeFileSync(join(storage, "untouched"), "");
  const openedLinks: string[] = [];

  // When
  const result = run(request, {
    ...host,
    openSync: (path, flags) => {
      if (/\/linked-(file|dir)$/u.test(path)) openedLinks.push(path);
      return host.openSync(path, flags);
    },
  });

  // Then
  expect(result).toEqual({
    code: 0,
    report: {
      changed: 3,
      incomplete: [],
      skipped: expect.arrayContaining(links.map((path) => ({ path, reason: "symlink" }))),
    },
  });
  expect(changed.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
    [target, plain, storage].map((path) => ({ path, uid, gid })),
  );
  expect(openedLinks).toEqual([]);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
});

linux("reports a hard link and a FIFO without changing either", () => {
  // Given
  const { home, target, request, host, changed } = fixture();
  const link = join(target, "hard-link");
  const original = join(home, "original");
  fs.writeFileSync(original, "");
  fs.linkSync(original, link);
  const fifo = join(target, "fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

  // When
  const result = run({ ...request, paths: [link, fifo] }, host);

  // Then
  expect(result).toEqual({
    code: 0,
    report: {
      changed: 0,
      incomplete: [],
      skipped: [
        { path: link, reason: "hard-link" },
        { path: fifo, reason: "special-file" },
      ],
    },
  });
  expect(changed).toEqual([]);
});

linux("does not report a special file or mount point that another owner holds", () => {
  // Given a FIFO and a mount point inside the target, both owned by someone else.
  const { target, request, host, changed } = fixture();
  const fifo = join(target, "fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const mount = join(target, "mount");
  fs.mkdirSync(mount);
  const foreign = (path: string) => path.endsWith("/fifo") || path.endsWith("/mount");

  // When
  const result = run(request, {
    ...host,
    lstatSync: (path) => {
      const stat = host.lstatSync(path);
      if (!foreign(path)) return stat;
      return Object.assign(stat, {
        uid: stat.uid + 1n,
        dev: path.endsWith("/mount") ? stat.dev + 1n : stat.dev,
      });
    },
  });

  // Then neither was the walker's to change, so neither is left over.
  expect(result).toMatchObject({ code: 0, report: { skipped: [], incomplete: [] } });
  expect(changed.map(({ path }) => path)).not.toContain(fifo);
});

linux("only changes matching owners, using root as the default previous owner", () => {
  // Given
  const {
    target,
    request,
    host: { fromUid: _fromUid, ...host },
    changed,
    uid,
    gid,
  } = fixture();
  const rootOwned = join(target, "root-owned");
  fs.writeFileSync(rootOwned, "");
  fs.writeFileSync(join(target, "user-owned"), "");

  // When
  const result = run(request, {
    ...host,
    fstatSync: (fd) => {
      const stat = host.fstatSync(fd);
      return fs.readlinkSync(`/proc/self/fd/${fd}`) === rootOwned ? Object.assign(stat, { uid: 0n }) : stat;
    },
  });

  // Then
  expect(result).toEqual({ code: 0, report: { changed: 1, skipped: [], incomplete: [] } });
  expect(changed).toEqual([{ path: rootOwned, uid, gid }]);
});

linux("reports a different inode between lstat and open without changing it", () => {
  // Given
  const { target, request, host, changed } = fixture();
  const file = join(target, "file");
  fs.writeFileSync(file, "");

  // When
  const result = run(
    { ...request, paths: [file] },
    {
      ...host,
      fstatSync: (fd) => {
        const stat = host.fstatSync(fd);
        return fs.readlinkSync(`/proc/self/fd/${fd}`) === file
          ? Object.assign(stat, { ino: stat.ino + 1n })
          : stat;
      },
    },
  );

  // Then
  expect(result).toEqual({
    code: 3,
    report: { changed: 0, skipped: [{ path: file, reason: "changed-during-repair" }], incomplete: [file] },
  });
  expect(changed).toEqual([]);
});

linux("stops at the storage inode after a rename and won’t repair an explicit target under storage", () => {
  // Given
  const { target, storage, request, host, changed } = fixture();
  const file = join(storage, "file");
  fs.writeFileSync(file, "");
  const moved = join(target, "moved-storage");

  // When
  const result = run(
    { ...request, paths: [target, join(moved, "file")] },
    {
      ...host,
      readdirSync: (path) => {
        if (fs.readlinkSync(path) === target) fs.renameSync(storage, moved);
        return host.readdirSync(path);
      },
    },
  );

  // Then
  expect(result).toEqual({
    code: 0,
    report: { changed: 2, skipped: [{ path: moved, reason: "provider-storage" }], incomplete: [] },
  });
  expect(changed.map(({ path }) => path)).toEqual([target, moved]);
});

linux("does not open or repair entries on a separate device", () => {
  const { target, request, host, changed } = fixture();
  const file = join(target, "mount");
  fs.mkdirSync(file);
  const result = run(
    { ...request, paths: [file] },
    {
      ...host,
      lstatSync: (path) => {
        const stat = host.lstatSync(path);
        return path.endsWith("/mount") ? Object.assign(stat, { dev: stat.dev + 1n }) : stat;
      },
    },
  );
  expect(result).toEqual({
    code: 0,
    report: { changed: 0, incomplete: [], skipped: [{ path: file, reason: "cross-filesystem" }] },
  });
  expect(changed).toEqual([]);
});

linux("reports partial when paths extend beyond depth 64", () => {
  const { target, root, request, host, changed } = fixture();
  const limit = join(target, ...Array.from({ length: 63 }, () => "d"));
  const below = join(limit, "below");
  fs.mkdirSync(below, { recursive: true });

  const result = run({ ...request, paths: [root] }, host);

  expect(result).toEqual({ code: 3, report: { changed: 66, skipped: [], incomplete: [limit] } });
  expect(changed.some(({ path }) => path === below)).toBe(false);
});

linux("stops after 200,000 entries and caps skip details at 20", () => {
  const { target, root, request, host, changed } = fixture();
  const special = join(target, "special");
  fs.symlinkSync(join(target, "missing"), special);
  const stat = host.lstatSync(special);
  const entries = Array.from({ length: 200_000 }, () => Buffer.from("special"));

  const result = run(
    { ...request, paths: [root] },
    {
      ...host,
      readdirSync: (path) => (fs.readlinkSync(path) === target ? entries : host.readdirSync(path)),
      lstatSync: (path) => (path.endsWith("/special") ? stat : host.lstatSync(path)),
    },
  );

  expect(result).toEqual({
    code: 3,
    report: {
      changed: 2,
      skipped: Array.from({ length: 20 }, () => ({ path: special, reason: "symlink" })),
      incomplete: [special, target, root],
    },
  });
  expect(changed.map(({ path }) => path)).toEqual([root, target]);
});

linux("reports partial when an actionable skip cannot fit in the report", () => {
  const { home, target, request, host } = fixture();
  const original = join(home, "original");
  fs.writeFileSync(original, "");
  for (let index = 0; index < 20; index += 1) fs.symlinkSync(original, join(target, `alias-${index}`));
  fs.linkSync(original, join(target, "hard-link"));

  const result = run(request, {
    ...host,
    readdirSync: (path) => [...host.readdirSync(path)].sort(Buffer.compare),
  });

  expect(result).toMatchObject({ code: 3, report: { incomplete: [target] } });
});

linux("reports partial before the first change if the time budget is exhausted", () => {
  const { target, root, request, host, changed } = fixture();
  let time = -60_000;

  expect(run(request, { ...host, now: () => (time += 60_000) })).toEqual({
    code: 3,
    report: { changed: 0, skipped: [], incomplete: [root, target] },
  });
  expect(changed).toEqual([]);
});

type Fixture = ReturnType<typeof fixture>;
type RefusalCase = readonly [
  string,
  string,
  (f: Fixture) => Partial<RepairRequest>,
  (f: Fixture) => Partial<RepairHost>,
];
const unmodified = () => ({});
const refusals: readonly RefusalCase[] = [
  ["non-root euid", "not-root", unmodified, ({ uid }) => ({ euid: uid })],
  [
    "missing sudo uid",
    "sudo-identity-mismatch",
    unmodified,
    ({ gid }) => ({ env: { SUDO_GID: String(gid) } }),
  ],
  [
    "missing sudo gid",
    "sudo-identity-mismatch",
    unmodified,
    ({ uid }) => ({ env: { SUDO_UID: String(uid) } }),
  ],
  [
    "zero sudo uid",
    "sudo-identity-mismatch",
    unmodified,
    ({ host }) => ({ env: { ...host.env, SUDO_UID: "0" } }),
  ],
  [
    "zero sudo gid",
    "sudo-identity-mismatch",
    unmodified,
    ({ host }) => ({ env: { ...host.env, SUDO_GID: "0" } }),
  ],
  [
    "different sudo uid",
    "sudo-identity-mismatch",
    unmodified,
    ({ host, uid }) => ({ env: { ...host.env, SUDO_UID: String(uid + 1) } }),
  ],
  [
    "different sudo gid",
    "sudo-identity-mismatch",
    unmodified,
    ({ host, gid }) => ({ env: { ...host.env, SUDO_GID: String(gid + 1) } }),
  ],
  ["relative root", "invalid-root", () => ({ roots: ["relative"] }), unmodified],
  ["non-normalized root", "invalid-root", ({ root }) => ({ roots: [`${root}/.`] }), unmodified],
  ["filesystem root", "invalid-root", () => ({ roots: ["/"] }), unmodified],
  ["invoking home", "invalid-root", ({ home }) => ({ roots: [home] }), unmodified],
  ["unknown home", "invoking-home-unavailable", unmodified, () => ({ homeOf: () => undefined })],
  ["outside target", "path-outside-roots", ({ root }) => ({ paths: [`${root}-other/file`] }), unmodified],
  ["dot-dot target", "path-outside-roots", ({ root }) => ({ paths: [`${root}/../outside`] }), unmodified],
  [
    "storage in a non-data root",
    "storage-outside-data-root",
    ({ root, home }) => ({
      roots: [root, join(home, "other")],
      storage: join(home, "other/storage"),
    }),
    unmodified,
  ],
  [
    "symlinked root ancestor",
    "root-component-not-directory",
    ({ home, request }) => {
      const alias = join(home, "alias");
      fs.symlinkSync(home, alias);
      return { roots: [...request.roots, join(alias, "data")] };
    },
    unmodified,
  ],
  [
    "non-directory root ancestor",
    "root-component-not-directory",
    ({ home, request }) => {
      const file = join(home, "file");
      fs.writeFileSync(file, "");
      return { roots: [...request.roots, join(file, "data")] };
    },
    unmodified,
  ],
  [
    "writable root ancestor",
    "root-component-writable",
    unmodified,
    ({ home }) => {
      fs.chmodSync(home, 0o772);
      return {};
    },
  ],
  [
    "foreign-owned ancestor",
    "root-component-foreign-owner",
    unmodified,
    ({ home, uid, host }) => ({
      fstatSync: (fd) => {
        const stat = host.fstatSync(fd);
        return fs.readlinkSync(`/proc/self/fd/${fd}`) === home
          ? Object.assign(stat, { uid: BigInt(uid + 1) })
          : stat;
      },
    }),
  ],
  [
    "root-owned root parent",
    "root-parent-not-user-owned",
    unmodified,
    ({ home, host }) => ({
      fstatSync: (fd) => {
        const stat = host.fstatSync(fd);
        return fs.readlinkSync(`/proc/self/fd/${fd}`) === home ? Object.assign(stat, { uid: 0n }) : stat;
      },
    }),
  ],
  ["non-procfs fd path", "unsupported-platform", unmodified, () => ({ statfsSync: () => ({ type: 0 }) })],
  [
    "wrong proc fd view",
    "unsupported-platform",
    unmodified,
    ({ host, home }) => ({
      openSync: (path, flags) =>
        /^\/proc\/self\/fd\/\d+\/\.$/u.test(path) ? host.openSync(home, flags) : host.openSync(path, flags),
    }),
  ],
];

for (const [label, reason, requestOverrides, hostOverrides] of refusals) {
  linux(`refuses ${label} before changing ownership`, () => {
    const f = fixture();

    const result = run({ ...f.request, ...requestOverrides(f) }, { ...f.host, ...hostOverrides(f) });

    expect(result).toEqual({ code: 2, report: { refused: reason } });
    expect(f.changed).toEqual([]);
  });
}

test("refuses an unsupported platform before acquiring any filesystem handle", () => {
  const f = fixture();
  const operations: string[] = [];
  const result = run(
    { ...f.request, uid: 1000, gid: 1000 },
    {
      ...f.host,
      platform: "darwin",
      env: { SUDO_UID: "1000", SUDO_GID: "1000" },
      openSync: (path, flags) => {
        operations.push("open");
        return f.host.openSync(path, flags);
      },
      statfsSync: (path) => {
        operations.push("statfs");
        return f.host.statfsSync(path);
      },
    },
  );
  expect(result).toEqual({ code: 2, report: { refused: "unsupported-platform" } });
  expect(operations).toEqual([]);
  expect(f.changed).toEqual([]);
});

const args = [
  "--uid",
  "1000",
  "--gid",
  "1001",
  "--root",
  "/data",
  "--storage",
  "/data/runtime/storage",
  "--path",
  "/data/a file",
];
test.each([
  { argv: [...args, "--extra", "x"], refused: "unknown-flag" },
  { argv: [...args, "--uid", "1000"], refused: "duplicate-flag" },
  { argv: [...args, "--path", "/data/a file"], refused: "duplicate-flag" },
  { argv: [...args, "--root", "/data"], refused: "duplicate-flag" },
  { argv: [...args, "--storage", "/data/other"], refused: "duplicate-flag" },
  { argv: args.slice(0, -1), refused: "missing-value" },
  { argv: args.slice(0, -2), refused: "missing-flag" },
  { argv: ["--uid", "0", ...args.slice(2)], refused: "invalid-id" },
])("rejects malformed repair argv %#", ({ argv, refused }) => {
  expect(parseRepairArgs(argv)).toEqual({ refused });
});

test("uses an exact shell-free argv for the internal command and repeated paths", () => {
  const argv = repairArgv({
    invocation: ["/a bin/bun", "/a src/lando.ts"],
    uid: 1000,
    gid: 1001,
    roots: ["/data", "/cache"],
    storage: "/data/runtime/storage",
    paths: ["/data/a file", "/cache/$(shell)"],
  });
  expect(argv).toEqual([
    "/a bin/bun",
    "/a src/lando.ts",
    "__internal:repair-root-ownership",
    ...args.slice(0, 6),
    "--root",
    "/cache",
    ...args.slice(6),
    "--path",
    "/cache/$(shell)",
  ]);
  expect(parseRepairArgs(argv.slice(3))).toEqual({
    uid: 1000,
    gid: 1001,
    roots: ["/data", "/cache"],
    storage: "/data/runtime/storage",
    paths: ["/data/a file", "/cache/$(shell)"],
  });
});

test("leaves --storage out of a request without the data root, and parses it back", () => {
  const argv = repairArgv({
    invocation: ["lando"],
    uid: 1000,
    gid: 1001,
    roots: ["/cache"],
    paths: ["/cache/x"],
  });

  expect(argv).not.toContain("--storage");
  expect(parseRepairArgs(argv.slice(2))).toEqual({
    uid: 1000,
    gid: 1001,
    roots: ["/cache"],
    paths: ["/cache/x"],
  });
});

linux("repairs under another root when the request leaves the missing data root out", () => {
  // Given a root-owned cache entry, and a data root that does not exist.
  const { home, request, host, changed, uid, gid } = fixture();
  const cache = join(home, "cache");
  const entry = join(cache, "entry");
  fs.mkdirSync(entry, { recursive: true });

  // When the request names only the cache root and no storage.
  const result = run({ uid: request.uid, gid: request.gid, roots: [cache], paths: [entry] }, host);

  // Then the walker gives the entry back instead of refusing the whole request.
  expect(result).toEqual({ code: 0, report: { changed: 1, skipped: [], incomplete: [] } });
  expect(changed).toEqual([{ path: entry, uid, gid }]);
});
