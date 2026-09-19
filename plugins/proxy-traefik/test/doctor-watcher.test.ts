import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { HostPlatform } from "@lando/sdk/schema";

import {
  type WatcherDiagnosticRecord,
  makeRouterFileWatcherCheck,
  routerFileWatcherCheck,
} from "../src/doctor-watcher.ts";

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

  test("returns empty when the stored record is for a different provider", async () => {
    // Given: a record from a different provider is stale for this selection.
    const readRecord = () => Effect.succeed(matchingRecord({ providerId: "docker" }));

    // When: run under provider lando.
    const reports = await runCheck(readRecord, baseInput({ providerId: "lando" }));

    // Then: the docker-provider observation does not apply to lando.
    expect(reports).toEqual([]);
  });

  test("fails with a stale last-observation report for a matching inotify-limit record", async () => {
    // Given: a matching lando watcher diagnostic with failureClass inotify-limit.
    const record = matchingRecord();
    const readRecord = () => Effect.succeed(record);

    // When: run under provider lando.
    const reports = await runCheck(readRecord, baseInput({ providerId: "lando" }));

    // Then: exactly one fail report describing the last setup observation, not a live probe.
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
    expect(corpus).toContain("last router setup observation");
    expect(corpus).toContain("not been revalidated");
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
});
