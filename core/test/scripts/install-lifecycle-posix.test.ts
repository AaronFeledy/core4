// allow: SIZE_OK — one ordered filesystem lifecycle; independent phases would lose the preservation proof.
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeInstallRecord } from "@lando/engine/install/record";
import { update } from "@lando/engine/operations/update";
import { ProcessRunner, Telemetry } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  checksumVerifierFor,
  createFakeGpg,
  createReleaseFixture,
  fetcherForSelfUpdate,
  fileUrl,
  makeTempRoot,
  manifestWithBinary,
  noopProcessRunner,
  noopTelemetry,
  runCli,
  runInstaller,
  sandboxUninstallIo,
  sha256,
  tempRoots,
  textBytes,
  uninstall,
  verifierFor,
  withoutHostRuntimes,
} from "./install-lifecycle-support.ts";

const DryRunEnvelope = Schema.parseJson(
  Schema.Struct({
    ok: Schema.Boolean,
    result: Schema.Struct({
      dryRun: Schema.Boolean,
      mode: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          status: Schema.String,
          target: Schema.String,
        }),
      ),
    }),
  }),
);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hostile Lando 3 lifecycle", () => {
  test.each(["regular", "symlink"] as const)(
    "preserves a %s Lando 3 install across the Lando 4 lifecycle",
    async (kind) => {
      // Given (phase 0) one hostile installation, retained throughout every phase.
      const root = await makeTempRoot();
      const installDir = join(root, "bin");
      const dataRoot = join(root, "data");
      const cacheRoot = join(root, "cache");
      const confRoot = join(root, "conf");
      const legacyPath = join(installDir, "lando");
      const destination = join(installDir, "lando4");
      const recordPath = join(dataRoot, "install", "record.json");
      const legacyState = join(installDir, ".lando");
      const profilePath = join(root, ".profile");
      const profileBytes = textBytes(
        '# >>> LANDO shellenv >>>\nexport PATH="/legacy/lando/bin:$PATH"\n# <<< LANDO shellenv <<<\nexport USER_AUTHORED=keep\n',
      );
      await mkdir(installDir);
      switch (kind) {
        case "regular":
          await writeFile(legacyPath, "distinctive Lando 3 bytes", { mode: 0o700 });
          break;
        case "symlink": {
          const target = join(root, "legacy-target");
          await writeFile(target, "distinctive Lando 3 bytes", { mode: 0o700 });
          await symlink(target, legacyPath);
          break;
        }
        default: {
          const exhaustive: never = kind;
          throw new Error(`Unexpected legacy kind: ${exhaustive}`);
        }
      }
      await mkdir(legacyState, { mode: 0o700 });
      await writeFile(join(legacyState, "state"), "lando3 state", { mode: 0o600 });
      await writeFile(profilePath, profileBytes);
      const snapshotLegacy = async () => {
        const entry = await lstat(legacyPath);
        const link = entry.isSymbolicLink() ? await readlink(legacyPath) : undefined;
        return {
          mode: entry.mode & 0o777,
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
          link,
          bytes: await readFile(link ?? legacyPath),
          targetMode: (await lstat(link ?? legacyPath)).mode & 0o777,
          directoryMode: (await lstat(legacyState)).mode & 0o777,
          stateMode: (await lstat(join(legacyState, "state"))).mode & 0o777,
          stateBytes: await readFile(join(legacyState, "state")),
          profileBytes: await readFile(profilePath),
        };
      };
      const assertLegacyUnchanged = async (
        before: Awaited<ReturnType<typeof snapshotLegacy>>,
        phase: string,
      ) => {
        expect(await snapshotLegacy(), `Lando 3 preservation: ${phase}`).toEqual(before);
      };
      const before = await snapshotLegacy();
      const env = {
        HOME: root,
        LANDO_USER_DATA_ROOT: dataRoot,
        LANDO_USER_CACHE_ROOT: cacheRoot,
        LANDO_USER_CONF_ROOT: confRoot,
        LANDO_SHELL_PROFILE: profilePath,
        PATH: join(root, "no-host-runtimes"),
      };

      // When (phase 1) installing beside Lando 3 through the real POSIX installer.
      const fixture = await createReleaseFixture(root);
      const fixtureBytes = await readFile(fixture.binaryPath);
      const { gpgPath, logPath } = await createFakeGpg(root);
      const installed = await runInstaller({
        HOME: root,
        LANDO_INSTALL_DIR: installDir,
        LANDO_USER_DATA_ROOT: dataRoot,
        GPG_LOG: logPath,
        LANDO_INSTALL_GPG: gpgPath,
        LANDO_INSTALL_MANIFEST_URL: fileUrl(fixture.manifestPath),
        LANDO_INSTALL_OS: "Linux",
        LANDO_INSTALL_ARCH: "x86_64",
        LANDO_INSTALL_LIBC: "glibc",
      });
      // Then only the recorded Lando 4 executable is published.
      expect(installed).toMatchObject({ exitCode: 0, stderr: "" });
      expect((await lstat(destination)).isFile()).toBe(true);
      expect((await lstat(destination)).mode & 0o777).toBe(0o755);
      expect(await readFile(destination)).toEqual(fixtureBytes);
      const record = await Effect.runPromise(
        decodeInstallRecord(await readFile(recordPath, "utf8"), recordPath),
      );
      expect(record.data.executable).toMatchObject({
        path: destination,
        sha256: sha256(fixtureBytes),
        size: fixtureBytes.length,
        channel: "stable",
        platform: "linux-x64",
      });
      expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);
      expect((await readdir(installDir)).sort()).toEqual([".lando", "lando", "lando4"]);
      await assertLegacyUnchanged(before, "install");

      // When (phase 2) shellenv reads the real install record.
      const shellenv = await runCli(["shellenv"], env);
      // Then PATH uses the recorded directory, not the default.
      expect(shellenv.exitCode).toBe(0);
      expect(shellenv.stdout).toContain("export LANDO_USER_DATA_ROOT=");
      expect(shellenv.stdout).toContain(installDir);
      expect(shellenv.stdout).not.toContain(join(dataRoot, "bin"));
      await assertLegacyUnchanged(before, "shellenv");

      // When (phase 3) the real CLI plans a dry-run without host runtimes on PATH.
      const dryRun = await runCli(["uninstall", "--dry-run", "--format=json"], env);
      // Then the machine envelope names only the owned binary.
      expect(dryRun.exitCode).toBe(0);
      const envelope = Schema.decodeUnknownSync(DryRunEnvelope)(dryRun.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toMatchObject({ dryRun: true, mode: "keep-data" });
      expect(envelope.result.steps.find((step) => step.id === "installed-binary")).toMatchObject({
        status: "owned",
        target: destination,
      });
      expect(envelope.result.steps.some((step) => step.id === "install-record")).toBe(true);
      expect(envelope.result.steps.some((step) => step.target === legacyPath)).toBe(false);
      await assertLegacyUnchanged(before, "dry-run");

      // When (phase 4) an offline update replaces the explicitly recorded executable.
      const binaryBytes = textBytes("new-binary");
      const binarySha = sha256(binaryBytes);
      const manifest = manifestWithBinary({
        binarySha,
        binarySize: binaryBytes.length,
        platform: "linux-x64",
      });
      const execs: unknown[] = [];
      const updated = await Effect.runPromise(
        update({
          channel: "stable",
          only: "core",
          currentVersion: "4.2.0",
          fetchManifestBytes: fetcherForSelfUpdate({
            manifest,
            binaryBytes,
            checksumsText: `${binarySha}  ./dist/lando-linux-x64\n`,
          }),
          verifyManifestSignature: verifierFor(),
          verifyChecksumSignature: checksumVerifierFor(),
          updateStatePath: join(cacheRoot, "update-manifest-state.json"),
          selfUpdate: {
            installRecordFile: join(dataRoot, "install", "record.json"),
            platform: "linux",
            arch: "x64",
            argv: [destination, "update"],
            env: { PATH: "/usr/bin" },
            execve: (input) =>
              Effect.sync(() => {
                execs.push(input);
              }),
          },
        }).pipe(
          Effect.provideService(ProcessRunner, noopProcessRunner),
          Effect.provideService(Telemetry, noopTelemetry),
        ),
      );
      // Then the swap, backup, refreshed proof and re-exec all target Lando 4.
      expect(updated).toMatchObject({ updatedCore: true, coreUpdateAvailable: true });
      expect(await readFile(destination, "utf8")).toBe("new-binary");
      expect(await readFile(`${destination}.bak`)).toEqual(fixtureBytes);
      await expect(lstat(join(installDir, "lando.bak"))).rejects.toMatchObject({ code: "ENOENT" });
      const refreshed = await Effect.runPromise(
        decodeInstallRecord(await readFile(recordPath, "utf8"), recordPath),
      );
      expect(refreshed.data.executable).toMatchObject({
        path: destination,
        sha256: sha256(binaryBytes),
        size: binaryBytes.length,
      });
      expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);
      expect(execs).toHaveLength(1);
      expect(execs[0]).toMatchObject({ path: destination });
      await assertLegacyUnchanged(before, "update");

      // When (phase 5) shellenv consults the refreshed proof.
      const afterUpdate = await runCli(["shellenv"], env);
      // Then it still exports the recorded directory.
      expect(afterUpdate.exitCode).toBe(0);
      expect(afterUpdate.stdout).toContain("export LANDO_USER_DATA_ROOT=");
      expect(afterUpdate.stdout).toContain(installDir);
      expect(afterUpdate.stdout).not.toContain(join(dataRoot, "bin"));
      await assertLegacyUnchanged(before, "shellenv-after-update");

      await withoutHostRuntimes(async (seams) => {
        const options = {
          yes: true,
          userDataRoot: dataRoot,
          userCacheRoot: cacheRoot,
          userConfRoot: confRoot,
          ...sandboxUninstallIo(root),
          ...seams,
          reportFallbackDir: root,
        };
        // When (phase 6) uninstall executes with every host teardown seam inert.
        const removed = await Effect.runPromise(uninstall(options));
        // Then ownership bounds deletion and the record is retired last.
        expect(removed).toMatchObject({ failed: false, mode: "keep-data" });
        expect(removed.steps.find((step) => step.id === "installed-binary")).toMatchObject({
          status: "owned",
          outcome: "completed",
          target: destination,
        });
        expect(removed.steps.find((step) => step.id === "install-record")).toMatchObject({
          outcome: "completed",
        });
        expect(removed.steps.filter((step) => step.outcome === "completed").at(-1)?.id).toBe(
          "install-record",
        );
        await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(recordPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(`${destination}.bak`)).toEqual(fixtureBytes);
        const remaining = [".lando", "lando", "lando4.bak"];
        expect((await readdir(installDir)).sort()).toEqual(remaining);
        expect(await readFile(profilePath)).toEqual(Buffer.from(profileBytes));
        await assertLegacyUnchanged(before, "uninstall");

        // When (phase 7) the exact same uninstall runs again.
        const again = await Effect.runPromise(uninstall(options));
        // Then absent ownership is skipped, without touching the legacy installation.
        expect(again.failed).toBe(false);
        expect(again.steps.find((step) => step.id === "installed-binary")?.status).toBe("skipped");
        expect(again.steps.find((step) => step.id === "install-record")?.status).toBe("skipped");
        expect((await readdir(installDir)).sort()).toEqual(remaining);
        await assertLegacyUnchanged(before, "uninstall-again");
      });

      // When (phase 8) shellenv runs without an install record.
      const fallback = await runCli(["shellenv"], env);
      // Then it stops exporting the formerly recorded directory.
      expect(fallback.exitCode).toBe(0);
      expect(fallback.stdout).not.toContain(installDir);
      expect(fallback.stdout).toContain(join(dataRoot, "bin"));
      await assertLegacyUnchanged(before, "shellenv-after-uninstall");
    },
    120_000,
  );
});
