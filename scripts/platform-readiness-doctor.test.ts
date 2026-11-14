import { describe, expect, test } from "bun:test";

import { classifyPlatformReadinessDoctorResult } from "./platform-readiness-doctor.ts";

const WINDOWS_PREREQUISITE_ENVELOPE =
  '{"apiVersion":"v4","command":"meta:setup","ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required."}}';

const check = (input: {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly section?: string;
}) => ({
  section: input.section ?? "provider",
  name: input.name,
  status: input.status,
  severity:
    input.status === "fail"
      ? ("error" as const)
      : input.status === "warn"
        ? ("warn" as const)
        : ("info" as const),
  context: {},
  solutions: [],
});

const healthyDoctorReport = () => ({
  version: "4.0.0-dev.0",
  provider: {
    id: "lando",
    kind: "managed" as const,
    selection: { providerId: "lando", source: "default", inputs: { capabilityDefault: "lando" } },
  },
  checks: [check({ name: "setup-readiness", status: "pass" }), check({ name: "disk", status: "warn" })],
  skipped: [],
  summary: { checks: 2, passed: 1, warned: 1, failed: 0 },
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
  test("passes when doctor JSON is healthy with a warning and setup-readiness passes", () => {
    const report = healthyDoctorReport();
    expect(report.checks.some((entry) => entry.status === "warn")).toBe(true);
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

  test("fails exit 0 when the report includes a doctor-self check", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...healthyDoctorReport(),
          checks: [...healthyDoctorReport().checks, check({ name: "doctor-self", status: "pass" })],
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails exit 0 when any check has status fail", () => {
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...healthyDoctorReport(),
          checks: [...healthyDoctorReport().checks, check({ name: "engine", status: "fail" })],
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails when setup-readiness is missing", () => {
    const report = healthyDoctorReport();
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...report,
          checks: report.checks.filter((entry) => entry.name !== "setup-readiness"),
        }),
        stderr: "",
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("fails when setup-readiness does not pass", () => {
    const report = healthyDoctorReport();
    expect(
      classifyPlatformReadinessDoctorResult({
        exitCode: 0,
        stdout: doctorEnvelope({
          ...report,
          checks: report.checks.map((entry) =>
            entry.name === "setup-readiness" ? { ...entry, status: "warn" } : entry,
          ),
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
