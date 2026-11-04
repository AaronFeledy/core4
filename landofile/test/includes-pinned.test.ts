import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import type { GitTransport } from "@lando/source-acquisition";
import { Effect } from "effect";
import {
  resolveAuthoredIncludes,
  updateAuthoredIncludes,
  verifyAuthoredIncludes,
} from "./include-pipeline.ts";
import {
  gitDeps,
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
  seedGitSourceEntry,
} from "./support.ts";

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const SOURCE = "github:acme/shared/php.yml";
const CONTENT = "services:\n  web:\n    type: php\n";
const checksum = (content: string) => new Bun.CryptoHasher("sha256").update(content).digest("hex");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-pinned-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const options = (version?: string) => {
  const cacheRoot = join(root, "cache");
  return {
    appRoot: root,
    cacheRoot,
    ports: makeTestLandofilePorts(cacheRoot),
    stateStore: makeTestLandofileStateStore(cacheRoot),
    landofile: {
      includes: [
        { source: "github:acme/shared", path: "php.yml", ...(version === undefined ? {} : { version }) },
      ],
    },
  };
};
const writeLock = async (version?: string, content = CONTENT) => {
  const text = `includes:\n  - source: ${SOURCE}\n${version === undefined ? "" : `    version: ${version}\n`}    resolved: ${SHA}\n    checksum: ${checksum(content)}\n`;
  await Bun.write(join(root, ".lando.lock.yml"), text);
  return text;
};
const seedCache = async (content = CONTENT) => {
  await seedGitSourceEntry(join(root, "cache"), SHA, { "php.yml": content });
};
const cloner = (calls: Array<string | undefined>, commit = SHA, content = CONTENT) =>
  gitDeps({
    fetch: async ({ dest, ref }) => {
      calls.push(ref);
      await Bun.write(join(dest, "php.yml"), content);
      return { commit };
    },
  } satisfies GitTransport);
const recordingStore = (cacheRoot: string, onWrite: () => void): StateStoreShape => {
  const store = makeTestLandofileStateStore(cacheRoot);
  return {
    ...store,
    open: (spec) =>
      store.open(spec).pipe(
        Effect.map((bucket) => ({
          ...bucket,
          set: (value) => {
            if (spec.key === ".lando.lock.yml") onWrite();
            return bucket.set(value);
          },
        })),
      ),
  };
};

for (const useSuffix of [false, true]) {
  test(`first pin sends ${useSuffix ? "@ref" : "version:"} to git and round-trips the lock selector`, async () => {
    const calls: Array<string | undefined> = [];
    const input = options("v1");
    const landofile = useSuffix
      ? { includes: [{ source: "github:acme/shared@v1", path: "php.yml" }] }
      : input.landofile;
    await Effect.runPromise(resolveAuthoredIncludes({ ...input, landofile, deps: cloner(calls) }));
    const report = await Effect.runPromise(verifyAuthoredIncludes({ ...input, landofile, deps: cloner([]) }));
    expect(calls).toEqual(["v1"]);
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toContain("    version: v1\n");
    expect(report.entries[0]).toMatchObject({
      status: "ok",
      expected: `v1@${SHA}:${checksum(CONTENT)}`,
      actual: `v1@${SHA}:${checksum(CONTENT)}`,
    });
  });
}

test("warm pinned load and verify stay offline without rewriting the lock", async () => {
  const locked = await writeLock("main");
  await seedCache();
  let calls = 0;
  let writes = 0;
  const cacheRoot = join(root, "cache");
  const stateStore = recordingStore(cacheRoot, () => {
    writes++;
  });
  const deps = gitDeps({
    fetch: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  const loaded = await Effect.runPromise(resolveAuthoredIncludes({ ...options("main"), stateStore, deps }));
  const verified = await Effect.runPromise(verifyAuthoredIncludes({ ...options("main"), stateStore, deps }));
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
  expect(verified.ok).toBe(true);
  expect(calls).toBe(0);
  expect(writes).toBe(0);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
});

for (const returned of [SHA, NEW_SHA]) {
  test(`cold pinned load requests the locked SHA and ${returned === SHA ? "accepts it" : "rejects another SHA"}`, async () => {
    const locked = await writeLock();
    const calls: Array<string | undefined> = [];
    const load = resolveAuthoredIncludes({ ...options(), deps: cloner(calls, returned) });
    const result = await Effect.runPromise(Effect.result(load));
    expect(calls).toEqual([SHA]);
    if (returned === SHA) expect(result._tag).toBe("Success");
    else
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LandofileLockMismatchError" },
      });
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
  });
}

test("moving upstream HEAD does not affect a pinned load", async () => {
  await writeLock();
  await seedCache();
  const calls: Array<string | undefined> = [];
  const loaded = await Effect.runPromise(
    resolveAuthoredIncludes({ ...options(), deps: cloner(calls, NEW_SHA, "services: {}\n") }),
  );
  expect(calls).toEqual([]);
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
});

test("selector changes re-resolve the requested ref and replace only its lock entry", async () => {
  const locked = await writeLock("v1");
  const other = `  - source: github:acme/other/php.yml\n    resolved: ${SHA}\n    checksum: ${checksum(CONTENT)}\n`;
  await Bun.write(join(root, ".lando.lock.yml"), locked + other);
  const calls: Array<string | undefined> = [];
  await Effect.runPromise(resolveAuthoredIncludes({ ...options("v2"), deps: cloner(calls, NEW_SHA) }));
  expect(calls).toEqual(["v2"]);
  const entries = Bun.YAML.parse(await Bun.file(join(root, ".lando.lock.yml")).text());
  expect(entries).toEqual({
    includes: [
      { source: "github:acme/other/php.yml", resolved: SHA, checksum: checksum(CONTENT) },
      { source: SOURCE, version: "v2", resolved: NEW_SHA, checksum: checksum(CONTENT) },
    ],
  });
});

test("selector changes fail closed when acquisition is offline", async () => {
  const locked = await writeLock("v1");
  const calls: Array<string | undefined> = [];
  const error = await Effect.runPromise(
    Effect.flip(
      resolveAuthoredIncludes({
        ...options("v2"),
        deps: gitDeps({
          fetch: async ({ ref }) => {
            calls.push(ref);
            throw new Error("offline");
          },
        }),
      }),
    ),
  );
  expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "fetch-failed" });
  expect(calls).toEqual(["v2"]);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
});

test("selector changes reject offline update without acquisition or lock writes", async () => {
  const locked = await writeLock("v1");
  const calls: Array<string | undefined> = [];
  let writes = 0;
  const cacheRoot = join(root, "cache");
  const input = {
    ...options("v2"),
    stateStore: recordingStore(cacheRoot, () => {
      writes++;
    }),
    deps: cloner(calls),
  };
  const updateError = await Effect.runPromise(
    Effect.flip(updateAuthoredIncludes({ ...input, noNetwork: true })),
  );
  expect(updateError).toMatchObject({ _tag: "LandofileIncludeError", kind: "source-unresolved" });
  expect(calls).toEqual([]);
  expect(writes).toBeLessThanOrEqual(1);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
});

test("verify reports selector mismatch and suppresses stale entries after an incomplete walk", async () => {
  const locked = await writeLock("v1");
  await Bun.write(
    join(root, ".lando.lock.yml"),
    `${locked}  - source: github:acme/child/php.yml\n    resolved: ${SHA}\n    checksum: ${checksum(CONTENT)}\n`,
  );
  const calls: Array<string | undefined> = [];
  const report = await Effect.runPromise(verifyAuthoredIncludes({ ...options("v2"), deps: cloner(calls) }));
  expect(report.entries).toEqual([{ source: SOURCE, status: "mismatch", expected: "v1", actual: "v2" }]);
  expect(calls).toEqual([]);
});

test("corrupt cached parent fails its checksum before parsing or acquiring its child", async () => {
  await writeLock();
  await seedCache("includes:\n  - github:acme/child/php.yml\n");
  const calls: Array<string | undefined> = [];
  const error = await Effect.runPromise(
    Effect.flip(resolveAuthoredIncludes({ ...options(), deps: cloner(calls) })),
  );
  expect(error._tag).toBe("LandofileLockMismatchError");
  expect(calls).toEqual([]);
});

test("network refresh repairs a poisoned cache and records only fresh bytes", async () => {
  await writeLock();
  await seedCache("name: poisoned\n");
  const calls: Array<string | undefined> = [];
  const report = await Effect.runPromise(updateAuthoredIncludes({ ...options("main"), deps: cloner(calls) }));
  expect(report.entries[0]).toMatchObject({
    status: "updated",
    version: "main",
    resolved: SHA,
    checksum: checksum(CONTENT),
  });
  expect(calls).toEqual(["main"]);
  expect(await Bun.file(join(root, "cache", "sources", "git", SHA, "tree", "php.yml")).text()).toBe(CONTENT);
});

test("same-source conflicting selectors fail within one refresh walk", async () => {
  const calls: Array<string | undefined> = [];
  const input = options();
  const landofile = {
    includes: [
      { source: "github:acme/shared@v1", path: "php.yml" },
      { source: "github:acme/shared@v2", path: "php.yml" },
    ],
  };
  const error = await Effect.runPromise(
    Effect.flip(updateAuthoredIncludes({ ...input, landofile, deps: cloner(calls) })),
  );
  expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "source-unresolved" });
  expect(error.message).toContain("v1");
  expect(error.message).toContain("v2");
  expect(calls).toEqual(["v1"]);
  expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
});

test("cold pinned load resolves under a symlinked user cache root", async () => {
  const realCache = join(root, "real-cache");
  await mkdir(join(realCache, "sources", "git"), { recursive: true });
  const linkedCache = join(root, "linked-cache");
  await symlink(realCache, linkedCache, "junction");
  await writeLock();
  const calls: Array<string | undefined> = [];
  const result = await Effect.runPromise(
    resolveAuthoredIncludes({
      ...options(),
      cacheRoot: linkedCache,
      ports: makeTestLandofilePorts(linkedCache),
      stateStore: makeTestLandofileStateStore(linkedCache),
      deps: cloner(calls),
    }),
  );
  expect(calls).toEqual([SHA]);
  expect(result.services?.[ServiceName.make("web")]?.type).toBe("php");
  expect(await Bun.file(join(realCache, "sources", "git", SHA, "tree", "php.yml")).text()).toBe(CONTENT);
});
