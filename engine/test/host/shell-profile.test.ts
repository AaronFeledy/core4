import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Option } from "effect";

import {
  LANDO_SHELLENV_BEGIN,
  installShellProfileBlock,
  landoShellenvBlock,
} from "../../src/host/shell-profile.ts";
import * as BunFileSystem from "../../src/services/file-system";

const install = (profile: string, block: string) =>
  installShellProfileBlock(profile, block).pipe(Effect.provide(BunFileSystem.layer));

const withTemp = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-shell-profile-"));
  try {
    await run(dir);
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
};

describe("installShellProfileBlock", () => {
  test("creates a missing profile and its directories as the invoking user", () =>
    withTemp(async (dir) => {
      // Given a profile path whose parents do not exist yet.
      const profile = join(dir, "new", "nested", ".zshrc");

      // When
      const outcome = await Effect.runPromise(install(profile, landoShellenvBlock("export A=1")));

      // Then everything it created belongs to this user, not root.
      expect(outcome).toBe("appended");
      const uid = process.getuid?.();
      for (const path of [join(dir, "new"), join(dir, "new", "nested"), profile]) {
        expect((await stat(path)).uid).toBe(uid ?? 0);
      }
      expect(await readFile(profile, "utf8")).toBe(`\n${landoShellenvBlock("export A=1")}\n`);
    }));

  test("appends once and keeps the user's existing lines", () =>
    withTemp(async (dir) => {
      const profile = join(dir, ".bashrc");
      const original = "# >>> LANDO shellenv >>>\nexport PATH=/lando3:$PATH\n# <<< LANDO shellenv <<<\n";
      await writeFile(profile, original);

      await Effect.runPromise(install(profile, landoShellenvBlock("export A=1")));
      const second = await Effect.runPromise(install(profile, landoShellenvBlock("export A=2")));

      const content = await readFile(profile, "utf8");
      expect(second).toBe("present");
      expect(content).toStartWith(`${original}\n${LANDO_SHELLENV_BEGIN}\n`);
      expect(content.split(LANDO_SHELLENV_BEGIN)).toHaveLength(2);
    }));

  test.skipIf(process.getuid?.() === 0)(
    "reports a profile linked to a file the user cannot write, without writing it",
    () =>
      withTemp(async (dir) => {
        // Given a symlink to a read-only target.
        const target = join(dir, "locked");
        await writeFile(target, "keep\n");
        await chmod(target, 0o444);
        const profile = join(dir, "profile-link");
        await symlink(target, profile);

        // When
        const exit = await Effect.runPromiseExit(install(profile, landoShellenvBlock("export A=1")));

        // Then the write fails with a permission error and the target is unchanged.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag).toBe("FilePermissionError");
        }
        expect(await readFile(target, "utf8")).toBe("keep\n");
      }),
  );
});
