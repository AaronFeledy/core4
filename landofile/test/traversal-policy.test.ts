import { expect, test } from "bun:test";
import { join, parse } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  LANDOFILE_BASENAMES,
  makeAppDiscoveryResolver,
  walkAppDirectories,
} from "../src/traversal-policy.ts";

const walk = (cwd: string, files: ReadonlyArray<string>) =>
  walkAppDirectories(cwd, {
    exists: async (path) => files.includes(path),
    excluded: () => false,
  });

test("checks the stop-marker directory but never its parent", async () => {
  const result = await walk("/workspace/boundary/child", [
    "/workspace/.lando.yml",
    "/workspace/boundary/.lando.stop",
  ]);
  expect(result).toEqual({
    kind: "stopped",
    cwd: "/workspace/boundary/child",
    directory: "/workspace/boundary",
    reason: "marker",
  });
});

for (const basename of LANDOFILE_BASENAMES) {
  for (const extension of ["yml", "ts"]) {
    test(`${basename}.${extension} wins in the marker directory`, async () => {
      const result = await walk("/workspace/boundary/child", [
        "/workspace/boundary/.lando.stop",
        `/workspace/boundary/${basename}.${extension}`,
      ]);
      expect(result).toMatchObject({ kind: "found", directory: "/workspace/boundary" });
    });
  }
}

test("finds a nested app below a stop marker despite conflicting forms", async () => {
  const result = await walk("/workspace/nested/child", [
    "/workspace/.lando.stop",
    "/workspace/nested/.lando.yml",
    "/workspace/nested/.lando.ts",
  ]);
  expect(result).toMatchObject({ kind: "found", directory: "/workspace/nested" });
});

test("stops at the filesystem root", async () => {
  const cwd = parse(process.cwd()).root;
  expect(await walk(cwd, [])).toEqual({ kind: "stopped", cwd, directory: cwd, reason: "root" });
});

test("checks exactly 64 parents and not the 65th", async () => {
  const base = join(parse(process.cwd()).root, "boundary");
  const cwd = join(base, ...Array.from({ length: 65 }, () => "child"));
  expect(await walk(cwd, [join(base, ".lando.yml")])).toMatchObject({
    kind: "stopped",
    directory: join(base, "child"),
    reason: "bound",
  });
  expect(await walk(cwd, [join(base, "child/.lando.yml")])).toMatchObject({
    kind: "found",
    directory: join(base, "child"),
  });
});

test("excludes the global root and the entire scratch tree", async () => {
  const paths = makeLandoPaths();
  for (const cwd of [paths.globalAppRoot, paths.scratchDir, join(paths.scratchDir, "id/app")]) {
    expect(await makeAppDiscoveryResolver().resolve(cwd)).toMatchObject({
      kind: "stopped",
      reason: "excluded",
    });
  }
});

test("shares an in-flight walk and discovered-root lookups only within its resolver", async () => {
  let walks = 0;
  const countedWalk: typeof walkAppDirectories = (cwd, access) => {
    walks++;
    return walkAppDirectories(cwd, access);
  };
  const access = { exists: async (path: string) => path === "/app/.lando.yml", excluded: () => false };
  const resolver = makeAppDiscoveryResolver(access, countedWalk);
  await Promise.all([resolver.resolve("/app/nested"), resolver.resolve("/app/nested")]);
  await resolver.resolve("/app");
  expect(walks).toBe(1);
  await makeAppDiscoveryResolver(access, countedWalk).resolve("/app/nested");
  expect(walks).toBe(2);
});
