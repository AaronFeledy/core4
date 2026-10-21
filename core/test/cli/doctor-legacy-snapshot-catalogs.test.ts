import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { legacySnapshotCatalogsDoctor } from "../../src/cli/commands/doctor-legacy-snapshot-catalogs";
import { collectDoctorReport } from "../../src/cli/commands/doctor-report";
import { configServiceLayer } from "./agent-env-test-config.ts";

test.each([false, true])(
  "doctor passes without legacy catalogs (snapshot directory exists: %s)",
  async (exists) => {
    // Given an isolated store, either absent or holding only a canonical catalog and an empty old directory.
    const root = await mkdtemp(join(tmpdir(), "lando-legacy-doctor-"));
    const paths = makeLandoPaths({ userDataRoot: root });
    try {
      if (exists) {
        const canonical = join(paths.snapshotsDir, "a".repeat(64));
        await mkdir(canonical, { recursive: true });
        await writeFile(join(canonical, "index.bin"), "not a legacy catalog");
        await mkdir(join(paths.snapshotsDir, "empty-old-app"));
        await writeFile(join(paths.snapshotsDir, "ordinary-file"), "ignored");
      }
      // When doctor inspects the filesystem without any provider services.
      const checks = await Effect.runPromise(
        legacySnapshotCatalogsDoctor((text) => text).pipe(Effect.provideService(PathsService, paths)),
      );
      // Then absence is a passing check.
      expect(checks).toMatchObject([
        { name: "legacy-snapshot-catalogs", status: "pass", context: { count: "0", paths: "" } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("doctor warns with redacted paths even when legacy catalog contents cannot be read", async () => {
  // Given invalid JSON and a dangling catalog symlink, both of which still protect images from GC.
  const root = await mkdtemp(join(tmpdir(), "lando-legacy-doctor-"));
  const paths = makeLandoPaths({ userDataRoot: root });
  const oldFile = join(paths.snapshotsDir, "old-app", "index.bin");
  const otherFile = join(paths.snapshotsDir, "other-app", "index.bin");
  const files = [oldFile, otherFile];
  try {
    await mkdir(join(paths.snapshotsDir, "old-app"), { recursive: true });
    await mkdir(join(paths.snapshotsDir, "other-app"));
    await writeFile(oldFile, "invalid JSON");
    await symlink(join(root, "absent"), otherFile);
    const redact = (text: string) => text.replaceAll(root, "<private>");
    // When doctor discovers paths without parsing or contacting a runtime.
    const checks = await Effect.runPromise(
      legacySnapshotCatalogsDoctor(redact).pipe(Effect.provideService(PathsService, paths)),
    );
    // Then both catalogs appear in a manual warning, with no private root exposed.
    expect(checks).toMatchObject([
      {
        name: "legacy-snapshot-catalogs",
        status: "warn",
        recovery: "manual",
        context: { count: "2", paths: files.map(redact).join("\n") },
        solutions: [{ kind: "manual" }],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "combined doctor report includes legacy catalogs without provider bootstrap, fix=%s",
  async (fix) => {
    // Given a development catalog and no runtime services.
    const root = await mkdtemp(join(tmpdir(), "lando-legacy-report-"));
    const paths = makeLandoPaths({ userDataRoot: root });
    const directory = join(paths.snapshotsDir, "old-app");
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.bin"), "{}");
      // When collecting the complete report, including the optional fix mode.
      const report = await Effect.runPromise(
        collectDoctorReport({
          options: { fix, env: {}, platform: "darwin" },
          provider: Effect.succeed({ checks: [] }),
          deprecations: Effect.succeed({ entries: [] }),
          subsystems: () => Effect.succeed({ checks: [] }),
        }).pipe(Effect.provideService(PathsService, paths), Effect.provide(configServiceLayer(config))),
      );
      // Then the registered check warns with manual recovery rather than starting a provider.
      expect(
        report.subsystems.checks.filter(({ name }) => name === "legacy-snapshot-catalogs"),
      ).toMatchObject([
        { status: "warn", recovery: "manual", context: { count: "1", paths: join(directory, "index.bin") } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
