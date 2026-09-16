import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowPerformanceSampleKey } from "../../../scripts/workflow-performance-plan.ts";
import {
  type WorkflowPerformanceReport,
  type WorkflowPerformanceSample,
  boundedPerformanceEvidence,
  decodeWorkflowPerformanceReport,
  evaluateWorkflowPerformanceReport,
  statisticsForSamples,
  writeWorkflowPerformanceReport,
} from "../../../scripts/workflow-performance-report.ts";

const sample = (
  index: number,
  outcome: "passed" | "failed",
  durationMs: number,
): WorkflowPerformanceSample => ({
  index,
  key: workflowPerformanceSampleKey("cold-first-start", index),
  outcome,
  resetCondition: "fresh roots and owned app identity",
  steps: [{ id: "start", durationMs, exitCode: outcome === "passed" ? 0 : 7, stdout: "", stderr: "" }],
});

const report = (samples: readonly WorkflowPerformanceSample[]): WorkflowPerformanceReport => ({
  schemaVersion: 1,
  series: { provider: "lando", platform: "linux-x64", fixtureSet: "db-v1" },
  run: {
    id: "42",
    attempt: 1,
    commit: "abc123",
    generatedAt: "2026-09-11T00:00:00.000Z",
    architecture: "x64",
    runner: "ubuntu-24.04",
  },
  versions: { binary: "4.0.0", runtime: "6.0.0", provider: "4.0.0" },
  fileSync: { eligible: false, reason: "native bind mounts" },
  fixtures: [],
  lanes: [
    {
      id: "cold-first-start",
      class: "start",
      outcome: samples.some((entry) => entry.outcome === "failed") ? "failed" : "passed",
      samples,
      statistics: statisticsForSamples(samples),
    },
  ],
});

const reportWithDiagnostic = (diagnostic: unknown): unknown => {
  const valid = report([sample(0, "failed", 10)]);
  return {
    ...valid,
    lanes: valid.lanes.map((lane) => ({
      ...lane,
      samples: lane.samples.map((entry) => ({
        ...entry,
        steps: entry.steps.map((step) => ({ ...step, diagnostic })),
      })),
    })),
  };
};

describe("workflow performance report", () => {
  test.each(["running", "interrupted", "failed"] as const)(
    "fails %s reports even before any lane completes",
    (status) => {
      const decoded = decodeWorkflowPerformanceReport({ ...report([]), lanes: [], status });
      expect(evaluateWorkflowPerformanceReport(decoded).exitCode).toBe(1);
      expect(
        evaluateWorkflowPerformanceReport(decodeWorkflowPerformanceReport(report([sample(0, "passed", 10)])))
          .exitCode,
      ).toBe(0);
    },
  );
  test("excludes failed samples from statistics and keeps timing advisory", () => {
    const samples = [sample(0, "passed", 10), sample(1, "failed", 1), sample(2, "passed", 30)];
    expect(statisticsForSamples(samples)).toEqual({
      successfulSamples: 2,
      minMs: 10,
      medianMs: 10,
      p95Ms: 30,
      maxMs: 30,
    });
    expect(evaluateWorkflowPerformanceReport(report(samples))).toEqual({
      exitCode: 1,
      reason: "workflow correctness or report plumbing failed",
    });
    expect(evaluateWorkflowPerformanceReport(report([sample(0, "passed", 90_000)])).exitCode).toBe(0);
  });

  test("bounds error evidence and validates reports through Effect Schema", () => {
    const bounded = boundedPerformanceEvidence("x".repeat(13_000));
    expect(bounded.endsWith("\n[truncated]")).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(12_012);
    expect(decodeWorkflowPerformanceReport(report([sample(0, "passed", 10)]))).toMatchObject({
      schemaVersion: 1,
    });
    expect(() => decodeWorkflowPerformanceReport({ ...report([]), schemaVersion: 2 })).toThrow();
    expect(
      decodeWorkflowPerformanceReport({
        ...report([sample(0, "passed", 10)]),
        lanes: [
          {
            ...report([sample(0, "passed", 10)]).lanes[0],
            samples: [
              {
                ...sample(0, "passed", 10),
                key: "perf-42-cold-first-start-1",
              },
            ],
          },
        ],
      }).lanes[0]?.samples[0]?.key,
    ).toBe("perf-42-cold-first-start-1");
  });

  test.each(["lane", "sample", "step"] as const)("rejects an unknown retained %s identifier", (field) => {
    // Given one nominal identifier contains an unrecognized custom secret.
    const secret = `custom-nonenv-secret-989-${field}`;
    const valid = report([sample(0, "passed", 10)]);
    const unsafe =
      field === "lane"
        ? { ...valid, lanes: [{ ...valid.lanes[0], id: secret }] }
        : field === "sample"
          ? {
              ...valid,
              lanes: [
                {
                  ...valid.lanes[0],
                  samples: [{ ...valid.lanes[0]?.samples[0], key: secret }],
                },
              ],
            }
          : {
              ...valid,
              lanes: [
                {
                  ...valid.lanes[0],
                  samples: [
                    {
                      ...valid.lanes[0]?.samples[0],
                      steps: [{ ...valid.lanes[0]?.samples[0]?.steps[0], id: secret }],
                    },
                  ],
                },
              ],
            };

    // When/Then the report crosses the schema boundary, it fails closed.
    expect(() => decodeWorkflowPerformanceReport(unsafe)).toThrow();
  });

  test.each([
    {
      domain: "image-pull" as const,
      failureKind: "registry-auth" as const,
      httpStatus: 401,
      transportKind: "http" as const,
    },
    {
      domain: "image-pull" as const,
      failureKind: "generic" as const,
      transportKind: "connect" as const,
    },
    ...(
      [
        "toomanyrequests",
        "denied",
        "manifest-unknown",
        "name-unknown",
        "no-such-host",
        "connection-refused",
        "timeout",
        "tls",
        "unknown",
      ] as const
    ).map((signature) => ({
      domain: "image-pull" as const,
      failureKind: "generic" as const,
      source: "stream-frame" as const,
      signature,
    })),
    ...(["ECONNABORTED", "ECONNRESET", "EPIPE", "ETIMEDOUT"] as const).map((systemCode) => ({
      domain: "image-pull" as const,
      failureKind: "generic" as const,
      transportKind: "read" as const,
      systemCode,
    })),
  ])("retains the closed image-pull diagnostic after durable write and read %#", async (diagnostic) => {
    // Given a failed step carries the safe diagnosis needed for the next run.
    const input = reportWithDiagnostic(diagnostic);

    const root = await mkdtemp(join(tmpdir(), "workflow-performance-diagnostic-"));
    const retainedPath = join(root, "report.json");
    try {
      // When the report crosses the durable writer and reader boundaries.
      await writeWorkflowPerformanceReport(decodeWorkflowPerformanceReport(input), retainedPath);
      const decoded = decodeWorkflowPerformanceReport(await Bun.file(retainedPath).json());

      // Then the closed diagnosis survives without any raw failure text.
      expect(decoded.lanes[0]?.samples[0]?.steps[0]?.diagnostic).toEqual(diagnostic);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { failureKind: "custom-nonenv-secret-989", transportKind: "http", httpStatus: 401 },
    { failureKind: "generic", transportKind: "custom-nonenv-secret-989", httpStatus: 401 },
    { failureKind: "generic", transportKind: "connect", httpStatus: 99 },
    { failureKind: "generic", transportKind: "connect", httpStatus: 600 },
    { failureKind: "generic", source: "private-source", signature: "unknown" },
    { failureKind: "generic", source: "stream-frame", signature: "private-signature" },
    { failureKind: "generic", transportKind: "read", systemCode: "PRIVATE_CODE" },
  ])("rejects an unrecognized or invalid image-pull diagnostic %#", (diagnostic) => {
    expect(() =>
      decodeWorkflowPerformanceReport(reportWithDiagnostic({ domain: "image-pull", ...diagnostic })),
    ).toThrow();
  });

  test("omits free-form diagnostic fields during an actual durable write and read", async () => {
    // Given a valid closed diagnostic is surrounded by untrusted frame, reference, path, and code fields.
    const root = await mkdtemp(join(tmpdir(), "workflow-performance-diagnostic-omission-"));
    const retainedPath = join(root, "report.json");
    const secret = "private-registry.example/team/private-image:latest";
    const input = reportWithDiagnostic({
      domain: "image-pull",
      failureKind: "generic",
      source: "stream-frame",
      signature: "unknown",
      message: `opaque failure for ${secret}`,
      reference: secret,
      registryHost: "private-registry.example",
      path: "/private/socket",
      code: "PRIVATE_CODE",
    });

    try {
      // When the report crosses the real decoder, durable writer, and reader.
      await writeWorkflowPerformanceReport(decodeWorkflowPerformanceReport(input), retainedPath);
      const decoded = decodeWorkflowPerformanceReport(await Bun.file(retainedPath).json());
      const serialized = JSON.stringify(decoded);

      // Then the closed unknown origin remains and every free-form field is absent.
      expect(decoded.lanes[0]?.samples[0]?.steps[0]?.diagnostic).toEqual({
        domain: "image-pull",
        failureKind: "generic",
        source: "stream-frame",
        signature: "unknown",
      });
      expect(serialized).not.toContain("opaque failure");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("private-registry.example");
      expect(serialized).not.toContain("/private/socket");
      expect(serialized).not.toContain("PRIVATE_CODE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omits every free-form diagnostic before retaining the report", async () => {
    // Given every retained free-form route contains a custom non-environment secret and private paths.
    const root = await mkdtemp(join(tmpdir(), "workflow-performance-retention-"));
    const secretPrefix = "custom-nonenv-";
    const secretSuffix = "secret-989-boundary";
    const secret = `${secretPrefix}${secretSuffix}`;
    const boundaryFragment = `${secret}${"x".repeat(12_000 - secret.length + 5)}`;
    const unsafe = `${secret} /home/private/app C:\\Users\\private\\lando \\\\private-host\\lando$\\runtime`;
    const routeIds = [
      "prepare:setup",
      "prepare:pre-pull",
      "prepare:start",
      "prepare:import",
      "prepare:snapshot",
      "prepare:failure",
      "start",
      "stop",
      "rebuild",
      "db:import",
      "db:restore",
      "validate:journey",
      "cleanup:destroy",
      "cleanup:global",
      "cleanup:runtime",
      "cleanup:storage",
    ] as const;
    const retainedPath = join(root, "report.json");
    const unsafeReport: WorkflowPerformanceReport = {
      ...report([]),
      status: "failed",
      failure: unsafe,
      fileSync: { eligible: false, reason: unsafe },
      lanes: [
        {
          id: "cold-first-start",
          class: "start",
          outcome: "failed",
          skipReason: unsafe,
          samples: [
            {
              ...sample(0, "failed", 12),
              resetCondition: unsafe,
              skipReason: unsafe,
              stagedFixture: { path: unsafe, bytes: 42, sha256: "abc123" },
              steps: routeIds.map((id, index) => ({
                id,
                durationMs: index + 1,
                exitCode: 70 + index,
                stdout: index === 0 ? boundaryFragment : unsafe,
                stderr: unsafe,
              })),
            },
          ],
        },
      ],
    };

    try {
      // When the real durable writer receives the report.
      await writeWorkflowPerformanceReport(unsafeReport, retainedPath);
      const retained = decodeWorkflowPerformanceReport(await Bun.file(retainedPath).json());
      const serialized = JSON.stringify(retained);

      // Then structured status survives while every free-form route is omitted before truncation.
      expect(retained.status).toBe("failed");
      expect(retained.failure).toBeUndefined();
      expect(retained.fileSync).toEqual({ eligible: false, reason: "[diagnostic evidence omitted]" });
      expect(retained.lanes[0]?.skipReason).toBeUndefined();
      expect(retained.lanes[0]?.samples[0]?.skipReason).toBeUndefined();
      expect(retained.lanes[0]?.samples[0]?.resetCondition).toBe("[diagnostic evidence omitted]");
      expect(retained.lanes[0]?.samples[0]?.stagedFixture).toEqual({
        path: "[diagnostic evidence omitted]",
        bytes: 42,
        sha256: "abc123",
      });
      expect(retained.lanes[0]?.samples[0]?.steps).toEqual(
        routeIds.map((id, index) => ({
          id,
          durationMs: index + 1,
          exitCode: 70 + index,
          stdout: "",
          stderr: "[diagnostic evidence omitted]",
        })),
      );
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secretPrefix);
      expect(serialized).not.toContain(secretSuffix);
      expect(serialized).not.toContain("/home/private");
      expect(serialized).not.toContain("C:\\Users\\private");
      expect(serialized).not.toContain("\\\\private-host\\lando$");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
