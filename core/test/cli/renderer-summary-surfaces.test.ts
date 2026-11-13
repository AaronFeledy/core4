import { describe, expect, test } from "bun:test";

import type { UninstallResult } from "@lando/engine/operations/uninstall";
import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import { formatSummary } from "@lando/renderer/summary";
import type { InfoAppResult } from "@lando/sdk/app";
import { AbsolutePath } from "@lando/sdk/schema";
import type { ScratchSummary } from "@lando/sdk/services";
import { setupSpec } from "../../src/cli/command-specs/meta/setup.ts";
import { caInjectionNote } from "../../src/cli/command-specs/meta/setup-summary.ts";
import type { DoctorCheck, DoctorReport } from "../../src/cli/commands/doctor-contract.ts";
import { doctorTreeSummary } from "../../src/cli/commands/doctor-progress.ts";
import {
  buildDoctorReportSummary,
  doctorCheckSection,
  renderDoctorReport,
} from "../../src/cli/commands/doctor-render-text.ts";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report.ts";
import { buildInfoSummary } from "../../src/cli/commands/info-render.ts";
import { buildGlobalStatusSummary } from "../../src/cli/commands/meta/global-status.ts";
import { buildScratchListSummary } from "../../src/cli/commands/scratch.ts";
import { buildUninstallSummary } from "../../src/cli/commands/uninstall.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

const nonEmptyLines = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.length > 0);

const expectFramed = (text: string, width: number): void => {
  const lines = nonEmptyLines(stripAnsi(text));
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) expect(displayWidth(line)).toBe(width);
  expect(lines[0]?.startsWith("╭─")).toBe(true);
  expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
};

const decorated = (columns: number): RenderContext => ({
  noColor: false,
  mode: "lando",
  format: "text",
  columns,
  isTTY: true,
});

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
        connections: [
          ...connections(["postgresql://lando@localhost:5432/postgres"]),
          ...connections(["tcp://你好世界-database-service:5432"], "app"),
        ],
      },
      {
        app: "my-app",
        service: "데이터베이스",
        api: 4,
        type: "valkey",
        provider: "lando",
        primary: false,
        status: "stopped",
        connections: [],
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

  test("lists the app-network address as its own field after the host endpoints", () => {
    const fields = buildInfoSummary(result).sections[0]?.rows.map((row) =>
      row.fields?.map((field) => `${field.label}=${field.value}`),
    );
    expect(fields).toEqual([
      [
        "type=postgres",
        "provider=lando",
        "Host=postgresql://lando@localhost:5432/postgres",
        "App Network=tcp://你好世界-database-service:5432",
      ],
      ["type=valkey", "provider=lando", "Host=not published", "App Network=-"],
    ]);
  });

  test("summarizes log-source availability without repeating provider details", () => {
    const reason =
      "This provider cannot follow log files. Set `strategy: redirect` on this source to view it with `lando logs`.";
    const [database, cache] = result.services;
    if (database === undefined || cache === undefined) throw new Error("info fixture services are missing");
    const withLogs: InfoAppResult = {
      ...result,
      services: [
        {
          ...database,
          logSources: [
            {
              id: "slow-query",
              path: "/var/log/mysql/slow.log",
              strategy: "follow",
              availability: "unavailable",
              reason,
            },
            {
              id: "general-query",
              path: "/var/log/mysql/general.log",
              strategy: "follow",
              availability: "unavailable",
              reason,
            },
            {
              id: "console-error",
              path: "/var/log/mysql/error.log",
              strategy: "redirect",
              availability: "redirected-to-console",
            },
          ],
        },
        { ...cache, logSources: [] },
      ],
    };

    const summary = buildInfoSummary(withLogs);
    const plain = stripAnsi(formatSummary(summary, { columns: 100 }));
    const detail = summary.sections[0]?.rows[0]?.fields?.find(
      (field) => field.label === "log details",
    )?.value;

    expect(plain).toContain("slow-query [unavailable], general-query [unavailable], console-error [console]");
    expect(detail?.split(reason)).toHaveLength(2);
    expect(summary.sections[0]?.notes).toEqual([
      "Run `lando info --format=json` for log paths and strategies.",
    ]);
    expect(summary.sections[0]?.rows[1]?.fields?.some((field) => field.label === "log sources")).toBe(false);
    expect(plain).not.toContain("/var/log/mysql/slow.log");
    expect(plain).not.toContain("(follow");
  });

  test("stays framed at a small terminal width", () => {
    expectFramed(formatSummary(buildInfoSummary(result), { columns: 36 }), 36);
  });
});

describe("scratch list summary", () => {
  const result: ReadonlyArray<ScratchSummary> = [
    {
      id: "scratch-node-1a2b3c",
      app: { kind: "scratch", id: "scratch-node-1a2b3c", root: AbsolutePath.make(LONG_PATH) },
      source: { kind: "fork" },
      mode: "cwd",
      created: "2026-06-19T12:00:00.000Z",
      status: "attached",
    },
  ];

  test("frames scratch instances with aligned fields", () => {
    const out = formatSummary(buildScratchListSummary(result), { columns: 70 });
    expectFramed(out, 70);
    expect(stripAnsi(out)).toContain("[OK]");
  });

  test("rolls orphan status up to the document tone", () => {
    const entry = result[0];
    if (entry === undefined) throw new Error("missing scratch fixture");
    const summary = buildScratchListSummary([{ ...entry, status: "orphan" }]);
    expect(summary.tone).toBe("error");
  });

  test("renders an explicit empty state", () => {
    const out = stripAnsi(formatSummary(buildScratchListSummary([]), { columns: 50 }));
    expect(out).toContain("No scratch apps found.");
  });
});

describe("global status summary", () => {
  const quality = {
    policyState: "available",
    runtimeState: "available",
    pending: [],
    diagnostics: [],
  } as const;
  test("frames materialized global services", () => {
    const out = formatSummary(
      buildGlobalStatusSummary({
        ...quality,
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
            desired: "enabled",
            pending: [],
            connections: connections(["http://localhost:80"]),
          },
        ],
      }),
      { columns: 64 },
    );
    expectFramed(out, 64);
    expect(stripAnsi(out)).toContain("[OK]");
  });

  test("rolls non-running global service states up to a warning header", () => {
    const summary = buildGlobalStatusSummary({
      ...quality,
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
          status: "stopped",
          desired: "disabled",
          pending: [],
          connections: [],
        },
      ],
    });
    expect(summary.tone).toBe("warn");
  });

  test("frames a not-installed global app", () => {
    const out = formatSummary(
      buildGlobalStatusSummary({ ...quality, app: "global", materialized: false, services: [] }),
      { columns: 48 },
    );
    expectFramed(out, 48);
    expect(stripAnsi(out)).toContain("Global configuration is not");
    expect(stripAnsi(out)).toContain("materialized.");
  });
});

describe("doctor summary", () => {
  const providerHeader = {
    id: "podman",
    kind: "user-installed" as const,
    selection: {
      providerId: "podman",
      source: "config" as const,
      inputs: { config: "podman", capabilityDefault: "lando" },
    },
    name: "Podman Runtime Provider",
    version: "5.1.0",
    runtimeStatus: "stopped",
    runtime: { running: false },
    capabilities: {},
  };
  const check = (overrides: Partial<DoctorCheck> = {}): DoctorCheck => ({
    section: "provider",
    name: "selected-provider",
    status: "pass",
    severity: "info",
    context: {},
    solutions: [],
    ...overrides,
  });
  const state = (checks: ReadonlyArray<DoctorCheck>, provider = providerHeader): DoctorReport =>
    makeDoctorReport({ version: "4.0.0-dev", provider, checks, skipped: [] });

  test("renders degraded doctor checks on the task-tree rail and preserves redaction markers", () => {
    const report = state([
      check({
        status: "warn",
        severity: "warn",
        runtimeStatus: "stopped",
        runtime: { running: false },
        context: { evidence: "connect failed: token=[redacted]" },
        solutions: [{ kind: "manual", description: "Run `lando setup`.", command: "lando setup" }],
      }),
    ]);
    const out = renderDoctorReport(report, decorated(80));
    expect(out.startsWith("\n")).toBe(true);
    for (const line of out.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(80);
    const text = stripAnsi(out);
    expect(text).toContain("Needs attention");
    expect(text).toContain("provider: podman");
    expect(text).toContain("selected-provider");
    expect(text).toContain("token=[redacted]");
    expect(text).toContain("Run `lando setup`.");
    expect(buildDoctorReportSummary(report).tone).toBe("warn");
  });

  test("hides passing checks by default and lists their full context under --all", () => {
    const report = state([
      check({
        context: { reason: "no-app-context" },
        solutions: [{ kind: "manual", description: "Run inside an app.", command: "lando doctor" }],
      }),
    ]);
    const summary = buildDoctorReportSummary(report);
    expect(summary.title).toBe("Healthy");
    expect(summary.tone).toBe("ok");
    expect(summary.subtitle).toContain("version: 4.0.0-dev");
    expect(summary.subtitle).toContain("provider: podman");
    expect(summary.sections.find((section) => section.title === "provider")).toBeUndefined();
    expect(summary.nextSteps).toBeUndefined();
    expect(summary.footer).toBe("1 checks passed · lando doctor --all lists every check");

    const all = buildDoctorReportSummary(report, { all: true });
    const provider = all.sections.find((section) => section.title === "provider");
    expect(provider?.rows[0]).toMatchObject({
      label: "selected-provider",
      tone: "ok",
      value: "pass",
    });
    expect(provider?.rows[0]?.fields).toContainEqual({ label: "reason", value: "no-app-context" });
    expect(provider?.rows[0]?.remedy).toContain("Run inside an app.");
    expect(all.footer).toBe("1 checks passed");
  });

  test("collapses repeated per-app findings into one row listing subjects", () => {
    const transport = (appId: string, socketType: string) =>
      check({
        name: "host-proxy-transport",
        subject: appId,
        status: "warn",
        severity: "warn",
        context: {
          appId,
          transport: "unix-socket",
          endpoint: `/run/${appId}/host-proxy.sock`,
          socketType,
          failure: "control-probe-failed",
        },
        solutions: [
          { kind: "manual", description: "Run lando restart from the app.", command: "lando restart" },
        ],
      });
    const summaryReport = state([
      check(),
      transport("alpha", "socket"),
      transport("beta", "socket"),
      transport("gamma", "missing"),
      transport("alpha", "socket"),
    ]);
    const summary = buildDoctorReportSummary(summaryReport);
    const rows = summary.sections.find((section) => section.title === "provider")?.rows;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toEqual({
      label: "host-proxy-transport",
      tone: "warn",
      value: "warn (4 checks)",
      fields: [
        { label: "entries", value: "alpha; beta; gamma" },
        { label: "remaining", value: "+1 more (lando doctor --all)" },
        { label: "transport", value: "unix-socket" },
        { label: "failure", value: "control-probe-failed" },
      ],
      remedy: "Run lando restart from the app.",
    });
    expect(summary.nextSteps).toEqual(["lando restart"]);
    expect(summary.footer).toBe("5 checks · 0 failed · 4 warnings · lando doctor --all lists every check");
    expect(
      buildDoctorReportSummary(summaryReport, { all: true }).sections.find(
        (section) => section.title === "provider",
      )?.rows,
    ).toHaveLength(5);
  });

  test("does not collapse same-named checks whose status or remediation differ", () => {
    const summary = buildDoctorReportSummary(
      state([
        check({ name: "host-proxy-transport", status: "pass" }),
        check({
          name: "host-proxy-transport",
          status: "warn",
          severity: "warn",
          solutions: [{ kind: "manual", description: "Restart.", command: "lando restart" }],
        }),
        check({
          name: "host-proxy-transport",
          status: "fail",
          severity: "error",
          solutions: [{ kind: "manual", description: "Rerun setup.", command: "lando setup" }],
        }),
      ]),
    );
    expect(summary.title).toBe("Problems found");
    const rows = summary.sections.find((section) => section.title === "provider")?.rows;
    expect(rows?.map((row) => row.tone)).toEqual(["warn", "error"]);
    expect(rows?.map((row) => row.remedy)).toEqual([
      "Restart. Run `lando restart`.",
      "Rerun setup. Run `lando setup`.",
    ]);
    expect(summary.nextSteps).toEqual(["lando restart"]);
  });

  test("counts error deprecations as failures in the title, footer, and tree summary", () => {
    const deprecated = makeDoctorReport({
      version: "4.0.0-dev",
      checks: [
        {
          section: "deprecations",
          name: "deprecation",
          status: "fail",
          severity: "error",
          context: { kind: "command", id: "app:legacy", since: "4.1.0" },
          solutions: [{ kind: "manual", description: "Old command is not supported." }],
        },
      ],
      skipped: [],
    });
    const summary = buildDoctorReportSummary(deprecated);
    expect(summary.sections.find((section) => section.title === "deprecations")?.rows[0]?.tone).toBe("error");
    expect(summary.title).toBe("Problems found");
    expect(summary.footer).toBe("1 checks · 1 failed");
    expect(doctorTreeSummary(deprecated.summary)).toBe("doctor · 1 problem found");
    const withPassingCheck = makeDoctorReport({
      version: "4.0.0-dev",
      checks: [
        {
          section: "deprecations",
          name: "deprecation",
          status: "fail",
          severity: "error",
          context: {},
          solutions: [],
        },
        check(),
      ],
      skipped: [],
    });
    expect(buildDoctorReportSummary(withPassingCheck).footer).toBe(
      "2 checks · 1 failed · lando doctor --all lists every check",
    );
  });

  test("counts warnings in the footer and keeps header tone aligned with rows", () => {
    const summary = buildDoctorReportSummary(
      state([
        check({
          name: "runtime-service",
          status: "warn",
          severity: "warn",
          runtimeStatus: "running",
          runtime: { running: true },
          context: { orphanPids: ["9"] },
          solutions: [{ kind: "manual", description: "kill leftover", command: "kill 9" }],
        }),
      ]),
    );
    expect(summary.tone).toBe("warn");
    expect(summary.footer).toBe("1 checks · 0 failed · 1 warning");
    const row = summary.sections.find((section) => section.title === "provider")?.rows[0];
    expect(row?.tone).toBe("warn");
    expect(row?.remedy).toBe("kill leftover Run `kill 9`.");
  });

  test("keeps an all-pass doctor report at OK with no warning footer", () => {
    const summary = buildDoctorReportSummary(state([check()]));
    expect(summary.tone).toBe("ok");
    expect(summary.footer).toBe("1 checks passed · lando doctor --all lists every check");
  });

  test("lists every deprecation finding without --all", () => {
    const deprecated = makeDoctorReport({
      version: "4.0.0-dev",
      checks: [
        {
          section: "deprecations",
          name: "deprecation",
          status: "pass",
          severity: "info",
          context: { kind: "flag", id: "legacy-flag", since: "4.2.0", source: "core", count: "1" },
          solutions: [{ kind: "manual", description: "Rename the flag." }],
        },
        {
          section: "deprecations",
          name: "deprecation",
          status: "fail",
          severity: "error",
          context: {
            kind: "command",
            id: "app:legacy",
            since: "4.1.0",
            source: "app:demo",
            count: "2",
          },
          solutions: [{ kind: "manual", description: "Stop using app:legacy." }],
        },
      ],
      skipped: [],
    });

    const rows = buildDoctorReportSummary(deprecated).sections.find(
      (section) => section.title === "deprecations",
    )?.rows;
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.fields).toContainEqual({ label: "id", value: "legacy-flag" });

    const text = renderDoctorReport(deprecated);
    expect(text).toContain("id: legacy-flag");
    expect(text).toContain("id: app:legacy");
  });

  test("distinguishes collapsed findings by app-config location and deprecation id", () => {
    const appConfig = (location: string): DoctorCheck => ({
      section: "app-config",
      name: "env-file.literal",
      subject: `/app/.lando.yml#${location}`,
      status: "warn",
      severity: "warn",
      context: { file: "/app/.lando.yml", location, message: "Environment file is a literal path." },
      solutions: [],
    });
    const summary = buildDoctorReportSummary(
      makeDoctorReport({
        version: "4.0.0-dev",
        checks: [appConfig("services.web.environment_file"), appConfig("services.db.environment_file")],
        skipped: [],
      }),
    );
    expect(
      summary.sections.find((section) => section.title === "app-config")?.rows[0]?.fields,
    ).toContainEqual({
      label: "entries",
      value: "/app/.lando.yml#services.web.environment_file; /app/.lando.yml#services.db.environment_file",
    });

    const deprecation = (id: string): DoctorCheck => ({
      section: "deprecations",
      name: "deprecation",
      subject: `flag:${id}`,
      status: "warn",
      severity: "warn",
      context: { kind: "flag", id, since: "4.2.0", source: "core", count: "1" },
      solutions: [],
    });
    const deprecations = doctorCheckSection(
      "deprecations",
      [deprecation("legacy-one"), deprecation("legacy-two")],
      {},
    );
    expect(deprecations?.rows[0]?.fields).toContainEqual({
      label: "entries",
      value: "flag:legacy-one; flag:legacy-two",
    });
  });

  test("omits the skipped section when nothing was skipped", () => {
    const clean = state([check()]);
    expect(buildDoctorReportSummary(clean).sections.map((section) => section.title)).not.toContain("skipped");
    expect(renderDoctorReport(clean)).not.toContain("No checks were skipped.");

    const withSkip = makeDoctorReport({
      version: "4.0.0-dev",
      checks: [],
      skipped: [{ section: "app-listeners", reason: "Runtime idle" }],
    });
    expect(buildDoctorReportSummary(withSkip).sections.map((section) => section.title)).toContain("skipped");
    expect(renderDoctorReport(withSkip)).toContain("Runtime idle");
  });

  test("counts app config lint in doctor footer when it contributes a failure", () => {
    const summary = buildDoctorReportSummary(
      makeDoctorReport({
        version: "4.0.0-dev",
        checks: [
          {
            section: "app-config",
            name: "landofile.validation",
            status: "fail",
            severity: "error",
            context: { file: "/tmp/demo/.lando.yml", message: "unexpected key" },
            solutions: [],
          },
        ],
        skipped: [],
      }),
    );
    expect(summary.footer).toBe("1 checks · 1 failed");
    expect(summary.tone).toBe("error");
  });
});

describe("setup summary via spec render", () => {
  const ctx: RenderContext = { mode: "lando", format: "text", columns: 72, isTTY: true, noColor: false };

  test("decorates setup completion in lando TTY mode", () => {
    const out = setupSpec.render?.(
      {
        providerId: "podman",
        installDir: LONG_PATH,
        fileSyncStatus: "deferred",
        networkCaInjectionConfigured: false,
      },
      undefined,
      ctx,
    );
    expect(out).toBeDefined();
    expectFramed(out ?? "", 72);
    expect(stripAnsi(out ?? "")).toContain("[WAIT]");
  });

  test("shows the CA injection note inside the decorated frame", () => {
    const out = setupSpec.render?.(
      {
        providerId: "podman",
        installDir: "/opt/lando",
        fileSyncStatus: "satisfied",
        networkCaInjectionConfigured: true,
      },
      undefined,
      ctx,
    );
    expect(out).toBeDefined();
    expectFramed(out ?? "", 72);
    const collapsed = stripAnsi(out ?? "").replace(/[\s│]+/gu, " ");
    expect(collapsed).toContain(`• ${caInjectionNote}`);
  });

  test("omits the CA injection note from the decorated frame when injection is unconfigured", () => {
    const out = setupSpec.render?.(
      {
        providerId: "podman",
        installDir: "/opt/lando",
        fileSyncStatus: "satisfied",
        networkCaInjectionConfigured: false,
      },
      undefined,
      ctx,
    );
    expect(out).toBeDefined();
    expectFramed(out ?? "", 72);
    const collapsed = stripAnsi(out ?? "").replace(/[\s│]+/gu, " ");
    expect(collapsed).not.toContain("certificate authorities");
    expect(collapsed).not.toContain("inject");
  });

  test("stays a plain line when not decorated", () => {
    const out = setupSpec.render?.(
      {
        providerId: "podman",
        installDir: "/opt/lando",
        fileSyncStatus: "installed",
        networkCaInjectionConfigured: false,
      },
      undefined,
      { mode: "plain", format: "text", columns: 80, isTTY: false, noColor: false },
    );
    expect(stripAnsi(out ?? "")).toContain("setup complete: Lando runtime (podman)");
    expect(out ?? "").not.toContain("╭─");
  });
});
