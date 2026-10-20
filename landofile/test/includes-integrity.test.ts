import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  resolveAuthoredIncludes,
  updateAuthoredIncludes,
  verifyAuthoredIncludes,
} from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root: string;
const SHA = "a".repeat(40);
const CONTENT = "services:\n  web:\n    type: php\n";
const checksum = new Bun.CryptoHasher("sha256").update(CONTENT).digest("hex");
const source = "github:acme/shared/php.yml";
const entry = `  - source: ${source}\n    resolved: ${SHA}\n    checksum: ${checksum}\n`;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-include-integrity-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const options = () => ({
  appRoot: root,
  cacheRoot: join(root, "cache"),
  ports: makeTestLandofilePorts(join(root, "cache")),
  stateStore: makeTestLandofileStateStore(),
});

for (const [name, body] of [
  ["incomplete entry", `  - source: ${source}\n    resolved: ${SHA}\n`],
  ["unknown field", `${entry}    unknown: no\n`],
  ["duplicate source", `${entry}${entry}`],
  ["duplicate field", `${entry}    resolved: ${SHA}\n`],
  ["uppercase checksum", entry.replace(checksum, checksum.toUpperCase())],
  ["short checksum", entry.replace(checksum, "abc")],
  ["empty resolved", entry.replace(SHA, "")],
  ["unterminated quoted source", entry.replace(`source: ${source}`, `source: '${source}`)],
  ["lone quote inside a quoted source", entry.replace(`source: ${source}`, `source: 'git'hub'`)],
] as const) {
  test(`corrupt lock with ${name} fails closed without acquisition or writes`, async () => {
    // Given
    const text = `includes:\n${body}`;
    await Bun.write(join(root, ".lando.lock.yml"), text);
    let calls = 0;
    // When
    const error = await Effect.runPromise(
      Effect.flip(
        updateAuthoredIncludes({
          ...options(),
          landofile: { includes: [source] },
          deps: {
            gitCloner: {
              clone: async () => {
                calls++;
                throw new Error("must not acquire");
              },
            },
          },
        }),
      ),
    );
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileParseError",
      message: expect.stringContaining(" is corrupt: "),
      filePath: join(root, ".lando.lock.yml"),
      remediation:
        "Restore .lando.lock.yml from version control or remove it, then run lando app:includes:update.",
    });
    expect(calls).toBe(0);
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(text);
  });
}

test("verify missing pin suppresses unreached stale entries without acquiring", async () => {
  // Given
  await Bun.write(join(root, ".lando.lock.yml"), `includes:\n${entry}`);
  // When
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({ ...options(), landofile: { includes: ["github:acme/missing/php.yml@main"] } }),
  );
  // Then
  expect(report.entries).toEqual([
    { source: "github:acme/missing/php.yml", status: "missing", expected: null, actual: "main" },
  ]);
});

test("network pin checks parent bytes before parsing its child", async () => {
  // Given
  await Bun.write(join(root, ".lando.lock.yml"), `includes:\n${entry}`);
  const refs: Array<string | undefined> = [];
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      resolveAuthoredIncludes({
        ...options(),
        landofile: { includes: [source] },
        deps: {
          gitCloner: {
            clone: async ({ dest, ref }) => {
              refs.push(ref);
              await Bun.write(join(dest, "php.yml"), "includes:\n  - github:acme/child/php.yml\n");
              return { commitSha: SHA };
            },
          },
        },
      }),
    ),
  );
  // Then
  expect(error._tag).toBe("LandofileLockMismatchError");
  expect(refs).toEqual([SHA]);
});

const npmDeps = (specs: string[], version = "1.2.3") => {
  const bytes = new Uint8Array([1]);
  return {
    npmRecipeSource: {
      resolve: async (spec: string) => {
        specs.push(spec);
        return {
          packageName: "@acme/fragments",
          version,
          dist: {
            tarball: "https://registry.example/pkg.tgz",
            shasum: createHash("sha1").update(bytes).digest("hex"),
          },
        };
      },
    },
    npmFetcher: { fetch: async () => bytes },
    npmExtractor: {
      extract: async (_bytes: Uint8Array, dest: string) => {
        await mkdir(join(dest, "package"), { recursive: true });
        await Bun.write(join(dest, "package", "web.yml"), CONTENT);
        await Bun.write(join(dest, "package", "cache.yml"), "services:\n  cache:\n    type: redis\n");
      },
    },
  };
};

test("two npm fragments from one package have distinct pins and unambiguous cache layout", async () => {
  // Given
  const specs: string[] = [];
  const input = {
    ...options(),
    landofile: {
      includes: [
        { source: "npm:@acme/fragments", path: "web.yml" },
        { source: "npm:@acme/fragments", path: "cache.yml" },
      ],
    },
    deps: npmDeps(specs),
  };
  // When
  const report = await Effect.runPromise(updateAuthoredIncludes(input));
  const loaded = await Effect.runPromise(resolveAuthoredIncludes({ ...input, deps: {} }));
  // Then
  expect(report.entries.map(({ source }) => source)).toEqual([
    "npm:@acme/fragments/cache.yml",
    "npm:@acme/fragments/web.yml",
  ]);
  expect(loaded.services?.[ServiceName.make("cache")]?.type).toBe("redis");
  expect(
    await Bun.file(
      join(root, "cache", "includes", "npm", "@acme+fragments@1.2.3", "package", "web.yml"),
    ).text(),
  ).toBe(CONTENT);
});

for (const returned of ["1.2.3", "2.0.0"]) {
  test(`cold npm pin requests exact version and ${returned === "1.2.3" ? "accepts it" : "rejects drift"}`, async () => {
    // Given
    const locked = `includes:\n  - source: npm:@acme/fragments/web.yml\n    version: latest\n    resolved: 1.2.3\n    checksum: ${checksum}\n`;
    await Bun.write(join(root, ".lando.lock.yml"), locked);
    const specs: string[] = [];
    // When
    const result = await Effect.runPromise(
      Effect.result(
        resolveAuthoredIncludes({
          ...options(),
          landofile: { includes: [{ source: "npm:@acme/fragments@latest", path: "web.yml" }] },
          deps: npmDeps(specs, returned),
        }),
      ),
    );
    // Then
    expect(specs).toEqual(["@acme/fragments@1.2.3"]);
    if (returned === "1.2.3") expect(result._tag).toBe("Success");
    else expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileLockMismatchError" } });
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(locked);
  });
}

test("npm network refresh repairs existing poisoned bytes instead of blessing them", async () => {
  // Given
  const cached = join(root, "cache", "includes", "npm", "@acme+fragments@1.2.3", "package");
  await mkdir(cached, { recursive: true });
  await Bun.write(join(cached, "web.yml"), "name: poisoned\n");
  // When
  const report = await Effect.runPromise(
    updateAuthoredIncludes({
      ...options(),
      landofile: { includes: [{ source: "npm:@acme/fragments", path: "web.yml" }] },
      deps: npmDeps([]),
    }),
  );
  // Then
  expect(report.entries[0]?.checksum).toBe(checksum);
  expect(await Bun.file(join(cached, "web.yml")).text()).toBe(CONTENT);
});

test("an npm registry version that would escape the include cache fails before anything is removed", async () => {
  // Given: a directory outside the include cache that a traversal could reach
  const outside = join(root, "cache", "includes", "keep");
  await mkdir(outside, { recursive: true });
  await Bun.write(join(outside, "web.yml"), "keep\n");
  // When: the registry reports a version containing path segments
  const error = await Effect.runPromise(
    Effect.flip(
      updateAuthoredIncludes({
        ...options(),
        landofile: { includes: [{ source: "npm:@acme/fragments", path: "web.yml" }] },
        deps: npmDeps([], "1.2.3/../../keep"),
      }),
    ),
  );
  // Then: the include fails as a fetch failure and the outside directory is untouched
  expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "fetch-failed" });
  expect(await Bun.file(join(outside, "web.yml")).text()).toBe("keep\n");
});

test("a lock entry whose npm version is not an exact version fails closed without acquisition", async () => {
  // Given
  await Bun.write(
    join(root, ".lando.lock.yml"),
    `includes:\n  - source: npm:@acme/fragments/web.yml\n    resolved: ../keep\n    checksum: ${checksum}\n`,
  );
  const specs: string[] = [];
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      resolveAuthoredIncludes({
        ...options(),
        landofile: { includes: [{ source: "npm:@acme/fragments", path: "web.yml" }] },
        deps: npmDeps(specs),
      }),
    ),
  );
  // Then
  expect(error).toMatchObject({ _tag: "LandofileLockMismatchError", expected: "exact npm package version" });
  expect(specs).toEqual([]);
});
