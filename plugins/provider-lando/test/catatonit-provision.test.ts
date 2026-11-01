import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import {
  CATATONIT_MANIFEST,
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
  ensureManagedCatatonit,
  managedCatatonitIdentityPath,
  managedCatatonitNoticesDir,
  managedCatatonitPath,
  runtimeInstalledVersionPath,
  runtimeRecipeIncludesNativeInitHelper,
} from "../src/catatonit-provision.ts";
import { catatonitFixture, staticElf } from "./fixtures/catatonit.ts";

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-catatonit-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const markBridge = async (runtimeBinDir: string, version: string = LEGACY_NATIVE_INIT_BRIDGE_VERSION) => {
  await mkdir(runtimeBinDir, { recursive: true, mode: 0o700 });
  await writeFile(runtimeInstalledVersionPath(runtimeBinDir), `${version}\n`);
};

describe("verified managed native init", () => {
  test("recipe runtime version is helper-bearing and distinct from the bridge marker", () => {
    expect(runtimeRecipeIncludesNativeInitHelper(CATATONIT_MANIFEST.recipeRuntimeVersion)).toBe(true);
    expect(runtimeRecipeIncludesNativeInitHelper(LEGACY_NATIVE_INIT_BRIDGE_VERSION)).toBe(false);
    expect(CATATONIT_MANIFEST.recipeRuntimeVersion).not.toBe(LEGACY_NATIVE_INIT_BRIDGE_VERSION);
  });

  test("supports an owner-controlled runtime under a symlinked home directory", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await mkdir(join(root, "home"));
      await symlink(join(root, "home"), join(root, "home-link"));
      const runtimeBinDir = join(root, "home-link", "bin");
      await markBridge(runtimeBinDir);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir,
          cacheDir: root,
          package: fixture.pkg,
          download: fixture.download,
          arch: "x64",
        }),
      );
      expect(new Uint8Array(await readFile(join(root, "home", "bin", "catatonit")))).toEqual(
        new Uint8Array(fixture.elf),
      );
    }));

  test("rejects a package pin for the wrong host architecture", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture(staticElf(183));
      await markBridge(root);
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: { ...fixture.pkg, elfMachine: 183 },
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(0);
    }));

  test("cancellation during download never publishes a helper", () =>
    withRoot(async (root) => {
      await markBridge(root);
      const started = Deferred.makeUnsafe<void>();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* ensureManagedCatatonit({
              runtimeBinDir: root,
              cacheDir: root,
              download: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            }).pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
          }),
        ),
      );
      expect(
        (await readdir(root)).filter(
          (name) => name !== ".runtime-installed-version" && name !== ".catatonit.identity",
        ),
      ).toEqual([]);
    }));

  test("installs an executable on first use for the exact 0.1.7 bridge marker", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      const runtimeBinDir = join(root, "bin");
      await markBridge(runtimeBinDir);
      const options = {
        runtimeBinDir,
        cacheDir: root,
        arch: "x64",
        package: fixture.pkg,
        download: fixture.download,
      };
      await Effect.runPromise(ensureManagedCatatonit(options));
      expect(new Uint8Array(await readFile(join(root, "bin", "catatonit")))).toEqual(
        new Uint8Array(fixture.elf),
      );
      expect((await lstat(join(root, "bin", "catatonit"))).mode & 0o777).toBe(0o755);
      expect((await readFile(runtimeInstalledVersionPath(runtimeBinDir), "utf8")).trim()).toBe(
        LEGACY_NATIVE_INIT_BRIDGE_VERSION,
      );
      expect(await readFile(join(managedCatatonitNoticesDir(runtimeBinDir), "COPYING"), "utf8")).toBe(
        new TextDecoder().decode(fixture.licenseBytes),
      );
      expect(await readFile(join(managedCatatonitNoticesDir(runtimeBinDir), "NOTICES.md"), "utf8")).toContain(
        fixture.pkg.license.spdx,
      );
      const identity = JSON.parse(await readFile(managedCatatonitIdentityPath(runtimeBinDir), "utf8"));
      expect(identity.binarySha256).toBe(fixture.pkg.binarySha256);
      expect(identity.packageSha256).toBe(fixture.pkg.sha256);
      expect(identity.version).toBe(fixture.pkg.version);
      expect(identity.member).toBe(fixture.pkg.member);
      expect(identity.elfMachine).toBe(fixture.pkg.elfMachine);
      expect(identity.license.texts[0]?.sha256).toBe(fixture.pkg.license.texts[0]?.sha256);
    }));

  test("reuses verified bytes without a network request", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      const options = {
        runtimeBinDir: root,
        cacheDir: root,
        arch: "x64",
        package: fixture.pkg,
        download: fixture.download,
      };
      await Effect.runPromise(ensureManagedCatatonit(options));
      await Effect.runPromise(ensureManagedCatatonit(options));
      // deb + one license text on first install only
      expect(fixture.downloads()).toBe(2);
    }));

  test("unknown installation markers fail setup without Debian fallback", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root, "0.1.6");
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(0);
      expect(await readdir(root)).toEqual([".runtime-installed-version"]);
    }));

  test("unknown markers fail even when a verified helper is already on disk", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      await writeFile(runtimeInstalledVersionPath(root), "0.1.6\n");
      const before = fixture.downloads();
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(before);
      expect(new Uint8Array(await readFile(managedCatatonitPath(root)))).toEqual(new Uint8Array(fixture.elf));
    }));

  test("unmarked installations fail setup without Debian fallback", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await mkdir(root, { recursive: true });
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(0);
    }));

  test("helper-bearing runtime damage fails without Debian fallback", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root, CATATONIT_MANIFEST.recipeRuntimeVersion);
      await writeFile(join(root, "catatonit"), "corrupt");
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(0);
      expect(await readFile(join(root, "catatonit"), "utf8")).toBe("corrupt");
    }));

  test("helper-bearing valid helper with missing notices fails without Debian fallback", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      // Promote helper to helper-bearing marker without packaged notices path intact.
      await writeFile(runtimeInstalledVersionPath(root), `${CATATONIT_MANIFEST.recipeRuntimeVersion}\n`);
      await rm(managedCatatonitNoticesDir(root), { recursive: true, force: true });
      const before = fixture.downloads();
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: root,
            cacheDir: root,
            arch: "x64",
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(before);
      expect(new Uint8Array(await readFile(managedCatatonitPath(root)))).toEqual(new Uint8Array(fixture.elf));
    }));

  test("helper-bearing valid helper with verified packaged notices reuses offline without bridge receipt", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      await writeFile(runtimeInstalledVersionPath(root), `${CATATONIT_MANIFEST.recipeRuntimeVersion}\n`);
      await rm(managedCatatonitIdentityPath(root), { force: true });
      const before = fixture.downloads();
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      expect(fixture.downloads()).toBe(before);
    }));

  test("interrupted install after helper before notices is not treated complete", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      await rm(managedCatatonitNoticesDir(root), { recursive: true, force: true });
      await rm(managedCatatonitIdentityPath(root), { force: true });
      // Helper alone remains; completion must still repair notices + identity without re-fetching the Deb.
      const before = fixture.downloads();
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      // license text only (no Deb)
      expect(fixture.downloads()).toBe(before + 1);
      expect(await readFile(join(managedCatatonitNoticesDir(root), "COPYING"), "utf8")).toBe(
        new TextDecoder().decode(fixture.licenseBytes),
      );
      expect(JSON.parse(await readFile(managedCatatonitIdentityPath(root), "utf8")).binarySha256).toBe(
        fixture.pkg.binarySha256,
      );
      expect(new Uint8Array(await readFile(managedCatatonitPath(root)))).toEqual(new Uint8Array(fixture.elf));
    }));

  test("identity tamper forces bridge receipt rewrite without Deb download when helper+notices valid", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      await writeFile(
        managedCatatonitIdentityPath(root),
        `${JSON.stringify({ schemaVersion: 1, kind: "bridge" })}\n`,
      );
      const before = fixture.downloads();
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      expect(fixture.downloads()).toBe(before);
      expect(JSON.parse(await readFile(managedCatatonitIdentityPath(root), "utf8")).packageSha256).toBe(
        fixture.pkg.sha256,
      );
    }));

  test("missing identity alone reuses helper and notices offline", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      await rm(managedCatatonitIdentityPath(root), { force: true });
      const before = fixture.downloads();
      await Effect.runPromise(
        ensureManagedCatatonit({
          runtimeBinDir: root,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        }),
      );
      expect(fixture.downloads()).toBe(before);
      expect(JSON.parse(await readFile(managedCatatonitIdentityPath(root), "utf8")).binarySha256).toBe(
        fixture.pkg.binarySha256,
      );
    }));

  for (const damage of ["corrupt", "missing", "mode", "setuid", "symlink"] as const) {
    test(`repairs ${damage} installed payloads on the 0.1.7 bridge`, () =>
      withRoot(async (root) => {
        const fixture = catatonitFixture();
        const runtimeBinDir = join(root, "bin");
        await markBridge(runtimeBinDir);
        const options = {
          runtimeBinDir,
          cacheDir: root,
          arch: "x64",
          package: fixture.pkg,
          download: fixture.download,
        };
        const target = join(options.runtimeBinDir, "catatonit");
        await Effect.runPromise(ensureManagedCatatonit(options));
        switch (damage) {
          case "corrupt":
            await writeFile(target, "bad");
            break;
          case "missing":
            await rm(target);
            break;
          case "mode":
            await chmod(target, 0o644);
            break;
          case "setuid":
            await chmod(target, 0o4755);
            break;
          case "symlink":
            await rm(target);
            await symlink(join(root, "foreign"), target);
            break;
        }
        await Effect.runPromise(ensureManagedCatatonit(options));
        expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array(fixture.elf));
        expect((await lstat(target)).isSymbolicLink()).toBe(false);
        expect((await lstat(target)).mode & 0o777).toBe(0o755);
        // first cycle: deb + license; repair reuses notices and only re-fetches the Deb
        expect(fixture.downloads()).toBe(3);
      }));
  }

  for (const invalid of [
    "package-digest",
    "binary-digest",
    "machine",
    "interpreter",
    "dynamic",
    "link",
  ] as const) {
    test(`rejects ${invalid} before publication`, () =>
      withRoot(async (root) => {
        const fixture = catatonitFixture(
          staticElf(
            invalid === "machine" ? 183 : 62,
            invalid === "interpreter" ? 3 : invalid === "dynamic" ? 2 : 1,
          ),
          invalid === "link" ? 50 : 48,
        );
        await markBridge(root);
        const pkg = {
          ...fixture.pkg,
          ...(invalid === "package-digest" ? { sha256: "0".repeat(64) } : {}),
          ...(invalid === "binary-digest" ? { binarySha256: "0".repeat(64) } : {}),
        };
        const result = await Effect.runPromise(
          Effect.result(
            ensureManagedCatatonit({
              runtimeBinDir: root,
              cacheDir: root,
              arch: "x64",
              package: pkg,
              download: fixture.download,
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(
          (await readdir(root)).filter(
            (name) => name !== ".runtime-installed-version" && name !== ".catatonit.identity",
          ),
        ).toEqual([]);
      }));
  }

  test("refuses a symlinked installation directory", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      const link = join(root, "bin");
      await symlink(root, link);
      await writeFile(runtimeInstalledVersionPath(root), `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`);
      const result = await Effect.runPromise(
        Effect.result(
          ensureManagedCatatonit({
            runtimeBinDir: link,
            cacheDir: root,
            package: fixture.pkg,
            download: fixture.download,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(fixture.downloads()).toBe(0);
    }));

  test("refuses notice writes when licenses or licenses/catatonit is a symlink", () =>
    withRoot(async (root) => {
      const fixture = catatonitFixture();
      await markBridge(root);
      const options = {
        runtimeBinDir: root,
        cacheDir: root,
        arch: "x64" as const,
        package: fixture.pkg,
        download: fixture.download,
      };
      await Effect.runPromise(ensureManagedCatatonit(options));
      // Keep verified helper; force notices rewrite with a symlinked licenses tree.
      await rm(join(root, "licenses"), { recursive: true, force: true });
      await rm(managedCatatonitIdentityPath(root), { force: true });
      const foreign = join(root, "foreign-licenses");
      await mkdir(foreign, { recursive: true, mode: 0o700 });
      await symlink(foreign, join(root, "licenses"));
      const before = fixture.downloads();
      const result = await Effect.runPromise(Effect.result(ensureManagedCatatonit(options)));
      expect(result._tag).toBe("Failure");
      // License fetch may occur before write; never publish through the symlink.
      expect(fixture.downloads()).toBeGreaterThanOrEqual(before);
      expect(await readdir(foreign)).toEqual([]);
      expect((await lstat(join(root, "licenses"))).isSymbolicLink()).toBe(true);
    }));
});
