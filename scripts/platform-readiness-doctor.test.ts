import { describe, expect, test } from "bun:test";

import { classifyPlatformReadinessDoctorResult } from "./platform-readiness-doctor.ts";

const WINDOWS_PREREQUISITE_ENVELOPE =
  '{"apiVersion":"v4","command":"meta:setup","ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required."}}';

const emptyChecks = { checks: [] } as const;

const managedProviderCheck = (input: {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly running: boolean;
}) => ({
  name: input.name,
  status: input.status,
  severity:
    input.status === "fail"
      ? ("error" as const)
      : input.status === "warn"
        ? ("warn" as const)
        : ("info" as const),
  providerId: "lando",
  providerName: "Lando",
  providerVersion: "4.0.0-dev.0",
  providerKind: "managed" as const,
  runtimeStatus: input.running ? "running" : "stopped",
  runtime: { running: input.running },
  capabilities: {},
  context: {},
  solutions: [],
});

const healthyDoctorReport = () => ({
  version: "4.0.0-dev.0",
  provider: {
    checks: [
      managedProviderCheck({ name: "setup-readiness", status: "pass", running: true }),
      managedProviderCheck({ name: "disk", status: "warn", running: true }),
    ],
  },
  subsystems: emptyChecks,
  globalApp: emptyChecks,
  mcp: emptyChecks,
});

const doctorEnvelope = (
  report: unknown,
  extras: { readonly command?: string; readonly ok?: boolean } = {},
): string =>
  JSON.stringify({
    apiVersion: "v4",
    command: extras.command ?? "meta:doctor",
    ok: extras.ok ?? true,
    result: report,
    warnings: [],
    deprecations: [],
  });

describe("platform readiness doctor classification", () => {
  test("passes when doctor JSON is healthy with a warning and setup-readiness running", () => {
    const report = healthyDoctorReport();
    expect(report.provider.checks.some((check) => check.status === "warn")).toBe(true);
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope(report),
        stderr: "",
      }),
    ).toEqual({
      outcome: "passed",
      exitCode: 0,
    });
  });

  test("fails a non-zero exit even when the JSON looks healthy", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 1,
        stdout: doctorEnvelope(healthyDoctorReport()),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails exit 0 when the report includes a self object", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...healthyDoctorReport(),
          self: {
            checks: [
              {
                name: "doctor-self",
                section: "provider",
                status: "fail",
                severity: "error",
                reason: "failure",
                context: {},
                solutions: [],
              },
            ],
          },
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails exit 0 when a provider, subsystems, globalApp, or mcp check has status fail", () => {
    const report = healthyDoctorReport();
    const failingCheck = managedProviderCheck({ name: "engine", status: "fail", running: true });
    const reports = {
      provider: {
        ...report,
        provider: { checks: [...report.provider.checks, failingCheck] },
      },
      subsystems: { ...report, subsystems: { checks: [failingCheck] } },
      globalApp: { ...report, globalApp: { checks: [failingCheck] } },
      mcp: { ...report, mcp: { checks: [failingCheck] } },
    } as const;

    for (const next of Object.values(reports)) {
      expect(
        classifyPlatformReadinessDoctorResult({
          exitCode: 0,
          stdout: doctorEnvelope(next),
          stderr: "",
        }),
      ).toMatchObject({ outcome: "failed", exitCode: 1 });
    }
  });

  test("fails when setup-readiness is missing", () => {
    const report = healthyDoctorReport();
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...report,
          provider: {
            checks: report.provider.checks.filter((check) => check.name !== "setup-readiness"),
          },
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails when setup-readiness passes but runtime is not running", () => {
    const report = healthyDoctorReport();
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...report,
          provider: {
            checks: report.provider.checks.map((check) =>
              check.name === "setup-readiness"
                ? { ...check, runtimeStatus: "stopped", runtime: { running: false } }
                : check,
            ),
          },
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails non-JSON stdout", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: "doctor completed\n",
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails when the envelope command is not meta:doctor", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope(healthyDoctorReport(), { command: "meta:setup" }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails when the envelope ok flag is false", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope(healthyDoctorReport(), { ok: false }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails the Hyper-V prerequisite envelope instead of treating it as a skip", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 1,
        stdout: "",
        stderr: WINDOWS_PREREQUISITE_ENVELOPE,
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });
});
