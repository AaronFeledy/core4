import { expect, test } from "bun:test";
import { dirname, relative, resolve, sep } from "node:path";
import { Schema } from "effect";

const repoRoot = resolve(import.meta.dirname, "../../..");

const TsconfigPaths = Schema.Struct({
  compilerOptions: Schema.optionalKey(
    Schema.Struct({ paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))) }),
  ),
});

const workspaceDirectories = async (): Promise<ReadonlyArray<string>> => {
  const manifest: { readonly workspaces: { readonly packages: ReadonlyArray<string> } } = await Bun.file(
    resolve(repoRoot, "package.json"),
  ).json();
  const directories: string[] = [];
  for (const pattern of manifest.workspaces.packages) {
    for await (const match of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: repoRoot })) {
      directories.push(resolve(repoRoot, dirname(match)));
    }
  }
  return directories;
};

const owningPackage = (path: string, packages: ReadonlyArray<string>): string | undefined =>
  packages
    .filter((directory) => path === directory || path.startsWith(directory + sep))
    .sort((left, right) => right.length - left.length)[0];

test("no tsconfig maps an import into another workspace package", async () => {
  // Given: Bun applies tsconfig `paths` at runtime. A mapping into another package gives that
  // package's files a second resolution path beside its `node_modules` workspace link, which
  // loads them twice whenever symlinks are preserved (#2382) and bypasses the target's exports map.
  // A repo-root tsconfig belongs to no package, and packages inherit its `paths` through `extends`.
  const packages = await workspaceDirectories();
  const tracked = await Bun.$`git ls-files ${"*tsconfig*.json"}`.cwd(repoRoot).text();
  const crossPackageTargets: string[] = [];

  // When
  for (const file of tracked.split("\n").filter((line) => line !== "")) {
    const tsconfigPath = resolve(repoRoot, file);
    const owner = owningPackage(tsconfigPath, packages);
    const config = Schema.decodeUnknownSync(TsconfigPaths)(
      Bun.JSONC.parse(await Bun.file(tsconfigPath).text()),
    );
    for (const [specifier, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
      for (const target of targets) {
        const targetOwner = owningPackage(resolve(dirname(tsconfigPath), target), packages);
        if (targetOwner !== undefined && targetOwner !== owner) {
          crossPackageTargets.push(`${file}: ${specifier} -> ${relative(repoRoot, targetOwner)}`);
        }
      }
    }
  }

  // Then
  expect(packages).toContain(resolve(repoRoot, "engine"));
  expect(crossPackageTargets).toEqual([]);
});
