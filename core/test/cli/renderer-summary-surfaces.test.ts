import { describe, expect, test } from "bun:test";

import type { ScratchSummary } from "@lando/sdk/services";
import type { DoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { buildDoctorReportSummary } from "../../src/cli/commands/doctor-report.ts";
import { type InfoAppResult, buildInfoSummary } from "../../src/cli/commands/info.ts";
import { buildGlobalStatusSummary } from "../../src/cli/commands/meta/global-status.ts";
import { buildScratchListSummary } from "../../src/cli/commands/scratch.ts";
import { type UninstallResult, buildUninstallSummary } from "../../src/cli/commands/uninstall.ts";
import { setupSpec } from "../../src/cli/oclif/commands/meta/setup.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { displayWidth, stripAnsi } from "../../src/cli/renderer/console-layout.ts";
import { formatSummary } from "../../src/cli/renderer/summary.ts";

const nonEmptyLines = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.length > 0);

const expectFramed = (text: string, width: number): void => {
  const lines = nonEmptyLines(stripAnsi(text));
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) expect(displayWidth(line)).toBe(width);
  expect(lines[0]?.startsWith("╭─")).toBe(true);
  expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
};

const LONG_PATH = `/home/user/.local/share/lando/${"providers/runtime-bundle/".repeat(12)}lando`;

describe("uninstall summary", () => {
  const result: UninstallResult = {
    dryRun: true,
    refused: false,
    mode: "keep-data",
    failed: false,
    steps: [
      {
        id: "managed-provider-runtime",
        label: "managed provider runtime",
        target: LONG_PATH,
        destructive: true,
        status: "skipped",
        detail: "Remove Lando-managed runtime bundles when present.",
      },
      {
        id: "ca-trust",
        label: "CA trust-store changes",
        target: "Lando local CA trust entry",
        destructive: false,
        status: "manual",
        detail: "Review entries; proxy token=[redacted] preserved.",
      },
    ],
  };

  test("frames a grouped plan with long paths at narrow width", () => {
    const out = formatSummary(buildUninstallSummary(result), { columns: 40 });
    expectFramed(out, 40);
    expect(stripAnsi(out)).toContain("[SKIP]");
  });

  test("passes a redaction marker through verbatim", () => {
    const out = stripAnsi(formatSummary(buildUninstallSummary(result), { columns: 90 }));
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("token=secret");
  });
});

describe("app:info summary", () => {
  const result: InfoAppResult = {
    app: "my-app",
    services: [
      {
        app: "my-app",
        service: "你好世界-database-service",
        api: 4,
        type: "postgres",
        provider: "lando",
        primary: true,
        status: "running",
        endpoints: ["postgresql://lando@localhost:5432/postgres"],
      },
      {
        app: "my-app",
        service: "데이터베이스",
        api: 4,
        type: "valkey",
        provider: "lando",
        primary: false,
        status: "stopped",
        endpoints: [],
      },
    ],
  };

  test("aligns CJK service names within the frame", () => {
    const out = formatSummary(buildInfoSummary(result), { columns: 60 });
    expectFramed(out, 60);
    const plain = stripAnsi(out);
    expect(plain).toContain("你好世界-database-service");
    expect(plain).toContain("데이터베이스");
    expect(plain).toContain("[OK]");
    expect(plain).toContain("[SKIP]");
  });

  test("stays framed at a small terminal width", () => {
    expectFramed(formatSummary(buildInfoSummary(result), { columns: 36 }), 36);
  });
});

describe("scratch list summary", () => {
  const result: ReadonlyArray<ScratchSummary> = [
    {
      id: "scratch-node-1a2b3c",
      app: { name: "scratch-node-1a2b3c", root: LONG_PATH },
      source: { kind: "fork" },
      mode: "none",
      created: "2026-06-19T12:00:00.000Z",
      status: "attached",
    },
  ];

  test("frames scratch instances with aligned fields", () => {
    const out = formatSummary(buildScratchListSummary(result), { columns: 70 });
    expectFramed(out, 70);
    expect(stripAnsi(out)).toContain("[OK]");
  });

  test("renders an explicit empty state", () => {
    const out = stripAnsi(formatSummary(buildScratchListSummary([]), { columns: 50 }));
    expect(out).toContain("No scratch apps found.");
  });
});

describe("global status summary", () => {
  test("frames materialized global services", () => {
    const out = formatSummary(
      buildGlobalStatusSummary({
        app: "global",
        materialized: true,
        services: [
          {
            app: "global",
            service: "traefik",
            api: 4,
            type: "traefik",
            provider: "lando",
            primary: true,
            status: "running",
            endpoints: ["http://localhost:80"],
          },
        ],
      }),
      { columns: 64 },
    );
    expectFramed(out, 64);
    expect(stripAnsi(out)).toContain("[OK]");
  });

  test("frames a not-installed global app", () => {
    const out = formatSummary(
      buildGlobalStatusSummary({ app: "global", materialized: false, services: [] }),
      { columns: 48 },
    );
    expectFramed(out, 48);
    expect(stripAnsi(out)).toContain("Global app is not installed.");
  });
});

describe("doctor summary", () => {
  const report: DoctorReport = {
    provider: {
      checks: [
        {
          name: "selected-provider",
          status: "warn",
          severity: "warn",
          providerId: "podman",
          providerName: "Podman Runtime Provider",
          providerVersion: "5.1.0",
          providerKind: "podman",
          runtimeStatus: "stopped",
          runtime: { running: false },
          capabilities: {},
          context: { providerId: "podman", evidence: "connect failed: token=[redacted]" },
          solutions: [{ kind: "manual", description: "Run `lando setup`.", command: "lando setup" }],
        },
      ],
    },
    subsystems: { checks: [] },
    globalApp: { checks: [] },
  } as unknown as DoctorReport;

  test("frames grouped doctor checks and preserves redaction markers", () => {
    const out = formatSummary(buildDoctorReportSummary(report), { columns: 80 });
    expectFramed(out, 80);
    const plain = stripAnsi(out);
    expect(plain).toContain("provider");
    expect(plain).toContain("[WARN]");
    expect(plain).toContain("[redacted]");
  });
});

describe("setup summary via spec render", () => {
  const ctx: RenderContext = { mode: "lando", columns: 72, isTTY: true };

  test("decorates setup completion in lando TTY mode", () => {
    const out = setupSpec.render?.(
      { providerId: "podman", installDir: LONG_PATH, fileSyncStatus: "deferred" },
      undefined,
      ctx,
    );
    expect(out).toBeDefined();
    expectFramed(out ?? "", 72);
    expect(stripAnsi(out ?? "")).toContain("[WAIT]");
  });

  test("stays a plain line when not decorated", () => {
    const out = setupSpec.render?.(
      { providerId: "podman", installDir: "/opt/lando", fileSyncStatus: "installed" },
      undefined,
      { mode: "plain", columns: 80, isTTY: false },
    );
    expect(stripAnsi(out ?? "")).toContain("setup complete: Lando runtime (podman)");
    expect(out ?? "").not.toContain("╭─");
  });
});
