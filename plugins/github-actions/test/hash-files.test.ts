import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { admitHashCatalogue } from "../src/contexts/hash-files.ts";
const source = { file: ".github/workflows/test.yml", line: 12 };
const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const catalogue = {
  authorization: "explicit" as const,
  canonicalRoot: "/captured/repository",
  caseSensitive: true,
  files: [
    { path: "z.txt", sha256: digest("z"), size: 1, identity: "inode-z" },
    { path: "src/a.ts", sha256: digest("a"), size: 1, identity: "inode-a" },
    { path: "src/private/a.ts", sha256: digest("private"), size: 7, identity: "inode-private" },
  ],
} as const;
test("hash catalogue uses sorted per-file binary digests, exclusions and empty match", async () => {
  const resolver = await Effect.runPromise(admitHashCatalogue(catalogue, source));
  const expected = new Bun.CryptoHasher("sha256").update(Buffer.from(digest("a"), "hex")).digest("hex");
  expect(resolver.resolve(["src/**/*.ts", "!src/private/**"])).toBe(expected);
  expect(resolver.resolve(["missing/**"])).toBe("");
  expect(resolver.resolve(["src/**/*.ts", "src/**/*.ts", "!src/private/**"])).toBe(expected);
});
test("catalogue rejects unsafe paths, duplicate identities, invalid digests and quotas", async () => {
  for (const file of [
    { ...catalogue.files[0], path: "../outside" },
    { ...catalogue.files[0], path: "/absolute" },
    { ...catalogue.files[0], path: "C:/outside" },
    { ...catalogue.files[0], sha256: "fake" },
    { ...catalogue.files[0], size: 100_000_000 },
  ]) {
    const result = await Effect.runPromise(
      Effect.result(admitHashCatalogue({ ...catalogue, files: [file] }, source)),
    );
    expect(Result.isFailure(result)).toBe(true);
  }
  const dup = await Effect.runPromise(
    Effect.result(
      admitHashCatalogue({ ...catalogue, files: [catalogue.files[0], catalogue.files[0]] }, source),
    ),
  );
  expect(Result.isFailure(dup)).toBe(true);
});
test("absolute, traversal and unsupported hash patterns fail before digest", async () => {
  const resolver = await Effect.runPromise(admitHashCatalogue(catalogue, source));
  for (const pattern of ["/src/*.ts", "../*", "C:/*.ts", "\\\\host\\file", "[a-z]", "src?.ts"])
    expect(() => resolver.resolve([pattern])).toThrow();
  expect(resolver.ioCapture).toBe("gated");
  expect(JSON.stringify(resolver)).not.toContain("captured");
});

test("hash catalogue freezes admitted facts and supports explicit case policy", async () => {
  const file = { path: "SRC/A.TS", sha256: digest("a"), size: 1, identity: "inode-a" };
  const input = { ...catalogue, caseSensitive: false, files: [file] };
  const resolver = await Effect.runPromise(admitHashCatalogue(input, source));
  const before = resolver.resolve(["src/**/*.ts"]);
  input.caseSensitive = true;
  file.path = "changed.ts";
  file.sha256 = digest("changed");
  expect(resolver.resolve(["src/**/*.ts"])).toBe(before);
  expect(before).not.toBe("");
});
