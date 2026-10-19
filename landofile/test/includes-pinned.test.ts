import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import type { GitIncludeCloner } from "../src/includes.ts";
import {
  resolveAuthoredIncludes,
  updateAuthoredIncludes,
  verifyAuthoredIncludes,
} from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

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
const options = (version?: string) => ({
  appRoot: root,
  cacheRoot: join(root, "cache"),
  ports: makeTestLandofilePorts(join(root, "cache")),
  stateStore: makeTestLandofileStateStore(),
  landofile: {
    includes: [
      { source: "github:acme/shared", path: "php.yml", ...(version === undefined ? {} : { version }) },
    ],
  },
});
const writeLock = async (version?: string, content = CONTENT) => {
  const text = `includes:\n  - source: ${SOURCE}\n${version === undefined ? "" : `    version: ${version}\n`}    resolved: ${SHA}\n    checksum: ${checksum(content)}\n`;
  await Bun.write(join(root, ".lando.lock.yml"), text);
  return text;
};
const seedCache = async (content = CONTENT) => {
  const dir = join(root, "cache", "includes", "git", SHA);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "php.yml"), content);
};
const cloner = (calls: Array<string | undefined>, commitSha = SHA, content = CONTENT): GitIncludeCloner => ({
  clone: async ({ dest, ref }) => {
    calls.push(ref);
    await Bun.write(join(dest, "php.yml"), content);
    return { commitSha };
  },
});
const recordingStore = (onWrite: () => void): StateStoreShape => {
  const store = makeTestLandofileStateStore();
  return {
    ...store,
    open: (spec) =>
      store.open(spec).pipe(
        Effect.map((bucket) => ({
          ...bucket,
          set: (value) => {
            onWrite();
            return bucket.set(value);
          },
        })),
      ),
  };
};

for (const useSuffix of [false, true]) {
  test(`first pin sends ${useSuffix ? "@ref" : "version:"} to git and round-trips the lock selector`, async () => {
    // Given
    const calls: Array<string | undefined> = [];
    const input = options("v1");
    const landofile = useSuffix
      ? { includes: [{ source: "github:acme/shared@v1", path: "php.yml" }] }
      : input.landofile;
    // When
    await Effect.runPromise(
      resolveAuthoredIncludes({ ...input, landofile, deps: { gitCloner: cloner(calls) } }),
    );
    const report = await Effect.runPromise(verifyAuthoredIncludes({ ...input, landofile }));
    // Then
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
  // Given
  const locked = await writeLock("main");
  await seedCache();
  let calls = 0;
  let writes = 0;
  const stateStore = recordingStore(() => {
    writes++;
  });
  const gitCloner: GitIncludeCloner = {
    clone: async () => {
      calls++;
      throw new Error("offline");
    },
  };
  // When
  const loaded = await Effect.runPromise(
    resolveAuthoredIncludes({ ...options("main"), stateStore, deps: { gitCloner } }),
  );
  const verified = await Effect.runPromise(
    verifyAuthoredIncludes({ ...options("main"), stateStore, deps: { gitCloner } }),
  );
  // Then
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
  expect(verified.ok).toBe(true);
  expect(calls).toBe(0);
  expect(writes).toBe(0);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
});

for (const returned of [SHA, NEW_SHA]) {
  test(`cold pinned load requests the locked SHA and ${returned === SHA ? "accepts it" : "rejects another SHA"}`, async () => {
    // Given
    const locked = await writeLock();
    const calls: Array<string | undefined> = [];
    const load = resolveAuthoredIncludes({ ...options(), deps: { gitCloner: cloner(calls, returned) } });
    // When
    const result = await Effect.runPromise(Effect.result(load));
    // Then
    expect(calls).toEqual([SHA]);
    if (returned === SHA) expect(result._tag).toBe("Success");
    else expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileLockMismatchError" } });
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
  });
}

test("moving upstream HEAD does not affect a pinned load", async () => {
  // Given
  await writeLock();
  await seedCache();
  const calls: Array<string | undefined> = [];
  // When
  const loaded = await Effect.runPromise(
    resolveAuthoredIncludes({ ...options(), deps: { gitCloner: cloner(calls, NEW_SHA, "services: {}\n") } }),
  );
  // Then
  expect(calls).toEqual([]);
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
});

test("selector changes reject load and offline update without acquisition or lock writes", async () => {
  // Given
  const locked = await writeLock("v1");
  const calls: Array<string | undefined> = [];
  let writes = 0;
  const input = {
    ...options("v2"),
    stateStore: recordingStore(() => {
      writes++;
    }),
    deps: { gitCloner: cloner(calls) },
  };
  // When
  const loadError = await Effect.runPromise(Effect.flip(resolveAuthoredIncludes(input)));
  const updateError = await Effect.runPromise(
    Effect.flip(updateAuthoredIncludes({ ...input, noNetwork: true })),
  );
  // Then
  expect(loadError).toMatchObject({ _tag: "LandofileLockMismatchError", expected: "v1", actual: "v2" });
  expect(updateError).toMatchObject({ _tag: "LandofileIncludeError", kind: "source-unresolved" });
  expect(calls).toEqual([]);
  expect(writes).toBe(0);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
});

test("verify reports selector mismatch and suppresses stale entries after an incomplete walk", async () => {
  // Given
  const locked = await writeLock("v1");
  await Bun.write(
    join(root, ".lando.lock.yml"),
    `${locked}  - source: github:acme/child/php.yml\n    resolved: ${SHA}\n    checksum: ${checksum(CONTENT)}\n`,
  );
  const calls: Array<string | undefined> = [];
  // When
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({ ...options("v2"), deps: { gitCloner: cloner(calls) } }),
  );
  // Then
  expect(report.entries).toEqual([{ source: SOURCE, status: "mismatch", expected: "v1", actual: "v2" }]);
  expect(calls).toEqual([]);
});

test("corrupt cached parent fails its checksum before parsing or acquiring its child", async () => {
  // Given
  await writeLock();
  await seedCache("includes:\n  - github:acme/child/php.yml\n");
  const calls: Array<string | undefined> = [];
  // When
  const error = await Effect.runPromise(
    Effect.flip(resolveAuthoredIncludes({ ...options(), deps: { gitCloner: cloner(calls) } })),
  );
  // Then
  expect(error._tag).toBe("LandofileLockMismatchError");
  expect(calls).toEqual([]);
});

test("network refresh repairs a poisoned cache and records only fresh bytes", async () => {
  // Given
  await writeLock();
  await seedCache("name: poisoned\n");
  const calls: Array<string | undefined> = [];
  // When
  const report = await Effect.runPromise(
    updateAuthoredIncludes({ ...options("main"), deps: { gitCloner: cloner(calls) } }),
  );
  // Then
  expect(report.entries[0]).toMatchObject({
    status: "updated",
    version: "main",
    resolved: SHA,
    checksum: checksum(CONTENT),
  });
  expect(calls).toEqual(["main"]);
  expect(await Bun.file(join(root, "cache", "includes", "git", SHA, "php.yml")).text()).toBe(CONTENT);
});

test("same-source conflicting selectors fail within one refresh walk", async () => {
  // Given
  const calls: Array<string | undefined> = [];
  const input = options();
  const landofile = {
    includes: [
      { source: "github:acme/shared@v1", path: "php.yml" },
      { source: "github:acme/shared@v2", path: "php.yml" },
    ],
  };
  // When
  const error = await Effect.runPromise(
    Effect.flip(updateAuthoredIncludes({ ...input, landofile, deps: { gitCloner: cloner(calls) } })),
  );
  // Then
  expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "source-unresolved" });
  expect(error.message).toContain("v1");
  expect(error.message).toContain("v2");
  expect(calls).toEqual(["v1"]);
  expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
});

test("cold pinned load resolves under a symlinked user cache root", async () => {
  // Given: the user cache root is a symlink to a directory that already holds the git cache root
  const realCache = join(root, "real-cache");
  await mkdir(join(realCache, "includes", "git"), { recursive: true });
  const linkedCache = join(root, "linked-cache");
  await symlink(realCache, linkedCache, "junction");
  await writeLock();
  const calls: Array<string | undefined> = [];
  // When
  const result = await Effect.runPromise(
    resolveAuthoredIncludes({
      ...options(),
      cacheRoot: linkedCache,
      ports: makeTestLandofilePorts(linkedCache),
      deps: { gitCloner: cloner(calls) },
    }),
  );
  // Then: the exact pinned commit is fetched and published into the real cache
  expect(calls).toEqual([SHA]);
  expect(result.services?.[ServiceName.make("web")]?.type).toBe("php");
  expect(await Bun.file(join(realCache, "includes", "git", SHA, "php.yml")).text()).toBe(CONTENT);
});
