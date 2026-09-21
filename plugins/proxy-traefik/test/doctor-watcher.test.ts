import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { RouterWatcherError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import {
  type WatcherDiagnosticRecord,
  makeRouterFileWatcherCheck,
  routerFileWatcherCheck,
} from "../src/doctor-watcher.ts";
import { dynamicConfigDir, watcherDiagnosticFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";

type DoctorRunInput = {
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataRoot: string | undefined;
  readonly binDir: string | undefined;
  readonly stateDir: string | undefined;
};

const baseInput = (overrides: Partial<DoctorRunInput> = {}): DoctorRunInput => ({
  providerId: "lando",
  platform: "linux",
  env: {},
  userDataRoot: "/tmp/lando-user-data",
  binDir: undefined,
  stateDir: undefined,
  ...overrides,
});

const matchingRecord = (overrides: Partial<WatcherDiagnosticRecord> = {}): WatcherDiagnosticRecord => ({
  version: 1,
  observedAt: "2026-09-18T12:00:00.000Z",
  providerId: "lando",
  watcherHost: "the Lando-managed Podman machine",
  failureClass: "inotify-limit",
  detail: "error adding file watcher for /etc/traefik/dynamic: no space left on device",
  ...overrides,
});

const runCheck = (
  readRecord: (input: DoctorRunInput) => Effect.Effect<WatcherDiagnosticRecord | undefined>,
  input: DoctorRunInput = baseInput(),
) => Effect.runPromise(makeRouterFileWatcherCheck(readRecord).run(input));

const solutionText = (solution: {
  readonly description: string;
  readonly command?: string | undefined;
}): string => [solution.description, solution.command ?? ""].join(" ");

const reportStalenessCorpus = (report: {
  readonly runtimeStatus?: string | undefined;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{ readonly description: string; readonly command?: string | undefined }>;
}): string =>
  [
    report.runtimeStatus ?? "",
    ...Object.values(report.context),
    ...report.solutions.map((solution) => solution.description),
  ].join(" ");

const makeDiskHarness = async (userDataRoot: string, text: string) => {
  const platform = "linux";
  const paths = makeLandoPaths({ userDataRoot, platform });
  const writeAtomic = (path: string, content: string | Uint8Array) =>
    Effect.tryPromise(async () => {
      const staged = `${path}.tmp`;
      await writeFile(staged, content, { mode: 0o600 });
      await rename(staged, path);
    });
  await mkdir(dynamicConfigDir(paths), { recursive: true });
  await writeFile(
    watcherDiagnosticFile(paths),
    JSON.stringify(matchingRecord({ failureClass: "permission", detail: "Previous file watcher failure" })),
  );
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    paths,
    fileSystem: {
      mkdir: (path) => Effect.tryPromise(() => mkdir(path, { recursive: true })).pipe(Effect.asVoid),
      exists: (path) =>
        Effect.tryPromise(() => access(path)).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      readDir: (path) => Effect.tryPromise(() => readdir(path)),
      readText: (path) => Effect.tryPromise(() => readFile(path, "utf8")),
      writeAtomic,
      writeSecretAtomic: writeAtomic,
      remove: (path) => Effect.tryPromise(() => rm(path, { recursive: true, force: true })),
    },
    globalApp: { ensureRunning: () => Effect.succeed([]) },
    readTraefikLogs: () => Effect.succeed({ providerId: "lando", text }),
  });
  return { service, input: baseInput({ userDataRoot, platform }) };
};

describe("makeRouterFileWatcherCheck", () => {
  test("returns empty and never calls the reader when userDataRoot is undefined", async () => {
    // Given: no user data root and a reader that would fail if called.
    let readerCalls = 0;
    const readRecord = () => {
      readerCalls += 1;
      return Effect.succeed(undefined);
    };

    // When: run the check without a userDataRoot.
    const reports = await runCheck(readRecord, baseInput({ userDataRoot: undefined }));

    // Then: no reports and the injected reader was never invoked.
    expect(reports).toEqual([]);
    expect(readerCalls).toBe(0);
  });

  test("returns empty when the injected reader yields undefined", async () => {
    // Given: a present userDataRoot and a reader with no stored diagnostic.
    const readRecord = () => Effect.succeed(undefined);

    // When: run the check.
    const reports = await runCheck(readRecord);

    // Then: silent (no diagnostic on disk).
    expect(reports).toEqual([]);
  });

  test("reports a lando-managed Traefik record when doctor selected a different app provider", async () => {
    // Given: last observation is from the global Traefik host, which is always the Lando-managed provider.
    const record = matchingRecord({ providerId: "lando" });
    const readRecord = () => Effect.succeed(record);

    // When: doctor selected docker because setup --provider=docker wrote defaultProviderId.
    const reports = await runCheck(readRecord, baseInput({ providerId: "docker" }));

    // Then: still report the watcher failure; context keeps the observing provider.
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toBeDefined();
    if (report === undefined) return;
    expect(report.status).toBe("fail");
    expect(report.context.providerId).toBe("lando");
    expect(report.context.failureClass).toBe("inotify-limit");
  });

  test("fails with a stale last-observation report for a matching inotify-limit record", async () => {
    // Given: a matching lando watcher diagnostic with failureClass inotify-limit.
    const record = matchingRecord();
    const readRecord = () => Effect.succeed(record);

    // When: run under provider lando.
    const reports = await runCheck(readRecord, baseInput({ providerId: "lando" }));

    // Then: exactly one fail report describing the last startup observation, not a live probe.
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.name).toBe("router-file-watcher");
    expect(report.status).toBe("fail");
    expect(report.severity).toBe("error");
    expect(report.runtimeStatus).toBe("file-watcher-failed");
    expect(report.runtime).toEqual({ running: false });

    const context = report.context;
    for (const key of [
      "proxyId",
      "failureClass",
      "watcherHost",
      "providerId",
      "observedAt",
      "detail",
    ] as const) {
      expect(Object.hasOwn(context, key)).toBe(true);
      expect(typeof context[key]).toBe("string");
    }
    expect(context.proxyId).toBe("traefik");
    expect(context.failureClass).toBe("inotify-limit");
    expect(context.detail).toBe(record.detail);

    expect(report.solutions.length).toBeGreaterThanOrEqual(1);
    for (const solution of report.solutions) {
      expect(solution.kind).toBe("manual");
    }
    const first = report.solutions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(solutionText(first).toLowerCase()).not.toContain("sysctl");
    expect(solutionText(first).toLowerCase()).not.toContain("sudo");

    const corpus = reportStalenessCorpus(report).toLowerCase();
    expect(corpus).toContain("persisted router startup observation");
    expect(corpus).toContain("not independently revalidated");
  });

  test("fails with a stale last-observation report for a matching permission record", async () => {
    // Given: a matching lando watcher diagnostic with failureClass permission.
    const record = matchingRecord({ failureClass: "permission" });
    const readRecord = () => Effect.succeed(record);

    // When: run under provider lando.
    const reports = await runCheck(readRecord, baseInput({ providerId: "lando" }));

    // Then: one fail report keyed on permission, first solution still non-privileged.
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.context.failureClass).toBe("permission");
    expect(report.solutions.length).toBeGreaterThanOrEqual(1);
    const first = report.solutions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(solutionText(first).toLowerCase()).not.toContain("sysctl");
    expect(solutionText(first).toLowerCase()).not.toContain("sudo");
  });
});

describe("routerFileWatcherCheck", () => {
  test("exports id router-file-watcher with no relevant predicate", () => {
    // Given / When: the default contribution export.
    // Then: fixed id and no capability filter.
    expect(routerFileWatcherCheck.id).toBe("router-file-watcher");
    expect(routerFileWatcherCheck.relevant).toBeUndefined();
  });

  test("still reports a record when startup revalidation rewrote the watcher failure", async () => {
    // Given: an older permission record on the same filesystem used by the real doctor reader.
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-watcher-"));
    try {
      const failureText =
        'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"';
      const { service, input } = await makeDiskHarness(userDataRoot, failureText);

      // When: revalidation observes an inotify failure, then doctor reads its persisted evidence.
      const failure = await Effect.runPromise(Effect.flip(service.revalidateStartup));
      expect(failure).toBeInstanceOf(RouterWatcherError);
      const reports = await Effect.runPromise(routerFileWatcherCheck.run(input));

      // Then: doctor reports the rewritten failure without claiming its own live revalidation.
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        name: "router-file-watcher",
        status: "fail",
        context: { failureClass: "inotify-limit", detail: failureText },
      });
      expect(reports[0]?.context.observation).toMatch(/not\b.*\brevalidated/i);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("reports nothing when healthy startup revalidation cleared the watcher record", async () => {
    // Given: an older persisted failure and healthy Traefik startup logs.
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-watcher-"));
    try {
      const { service, input } = await makeDiskHarness(
        userDataRoot,
        'level=info msg="Starting provider *file.Provider"',
      );

      // When: revalidation succeeds, then doctor reads from the same filesystem.
      await expect(Effect.runPromise(service.revalidateStartup)).resolves.toBeUndefined();
      const reports = await Effect.runPromise(routerFileWatcherCheck.run(input));

      // Then: no watcher failure remains for doctor to report.
      expect(reports).toEqual([]);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
