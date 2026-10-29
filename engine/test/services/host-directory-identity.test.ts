import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  captureHostExecutionContext,
  prepareHostExecutionContext,
} from "../../src/services/host-execution-context.ts";

test.skipIf(process.platform === "win32")(
  "resolves authored traversal and validates every erased directory prefix",
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-native-directory-"));
    try {
      await mkdir(join(root, "physical", "inside"), { recursive: true });
      await mkdir(join(root, "other"));
      await symlink("physical/inside", join(root, "link"));
      await symlink("other/../physical/inside", join(root, "target-parent"));
      await symlink("missing", join(root, "broken"));
      await symlink("loop", join(root, "loop"));
      await writeFile(join(root, "file"), "not a directory");
      const canonical = await realpath(root);
      const cases: ReadonlyArray<readonly [string, string]> = [
        [`${root}/link/..`, `${canonical}/physical`],
        [`${root}/target-parent/..`, `${canonical}/physical`],
        [`${relative(process.cwd(), root)}/link/..`, `${canonical}/physical`],
        [`${root}/link/../..`, canonical],
        [`${root}/link/./..//inside/..`, `${canonical}/physical`],
        [`${root}/.//`, canonical],
        ["/../../", "/"],
        [".", await realpath(process.cwd())],
      ];
      // When / Then
      for (const [cwd, expected] of cases) {
        const result = await prepareHostExecutionContext(captureHostExecutionContext({ cwd }));
        expect(result.cwd).toBe(expected);
        expect(result.env.PWD).toBe(expected);
      }
      for (const tail of [
        "missing/..",
        "file/..",
        "file/./..",
        "broken/..",
        "loop/..",
        "file",
        "missing",
        "loop",
      ]) {
        await expect(
          prepareHostExecutionContext(captureHostExecutionContext({ cwd: `${root}/${tail}` })),
        ).rejects.toMatchObject({ _tag: "FileIoError", path: `${root}/${tail}` });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("ordinary paths use one lookup and each authored parent requires one extra lookup", async () => {
  // Given
  const paths: string[] = [];
  const captured = captureHostExecutionContext(
    { cwd: "/one/two/../three/.." },
    { cwd: "/base", env: {}, platform: "linux" },
  );
  // When
  const result = await prepareHostExecutionContext(captured, async (path) => {
    paths.push(path);
    return paths.length === 1 ? "/physical/inside" : paths.length === 2 ? "/physical/three" : "/physical";
  });
  // Then
  expect(paths).toEqual(["/one/two/", "/physical/three/", "/physical/"]);
  expect(result.cwd).toBe("/physical");
});
