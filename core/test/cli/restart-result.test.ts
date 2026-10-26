import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { RestartAppResult } from "@lando/sdk/app";
import { PortNumber, type ServiceConnection } from "@lando/sdk/schema";
import { buildRestartSummary, renderRestartAppResult } from "../../src/cli/commands/restart.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

const pending: ServiceConnection = {
  scope: "host",
  source: "route",
  protocol: "https",
  host: "demo.lndo.site",
  pathPrefix: "/pending",
  endpoint: { port: PortNumber.make(3000), transport: "tcp", names: ["web"], primary: true },
  binding: "pending",
  state: "inactive",
};

const result: RestartAppResult = {
  app: "connection-demo",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: [
        ...connections(["https://demo.lndo.site/api", "http://demo.lndo.site/api"]),
        ...connections(["http://web:3000"], "app"),
        pending,
      ],
    },
    {
      name: "database",
      state: "stopped",
      connections: [
        ...connections(["postgresql://lando@localhost:5432/appdb"], "host", "inactive"),
        ...connections(["postgresql://lando@database:5432/appdb"], "app", "inactive"),
      ],
    },
    {
      name: "你好-worker",
      state: "unknown",
      connections: [
        ...connections(["http://localhost:4000"], "host", "unknown"),
        ...connections(["http://你好-worker:4000"], "app", "unknown"),
      ],
    },
    { name: "migrate", state: "completed", connections: [] },
  ],
};

const decorated = (columns: number): RenderContext => ({
  mode: "lando",
  format: "text",
  columns,
  isTTY: true,
  env: { TERM: "xterm-256color" },
});

const plainLine =
  "restarted: connection-demo - web (running) Host: https://demo.lndo.site/api, http://demo.lndo.site/api, demo.lndo.site/pending → 3000/tcp [pending · not published; inactive] App Network: http://web:3000; database (stopped) Host: postgresql://lando@localhost:5432/appdb [inactive] App Network: postgresql://lando@database:5432/appdb [inactive]; 你好-worker (unknown) Host: http://localhost:4000 [unknown] App Network: http://你好-worker:4000 [unknown]; migrate (completed) no endpoints";

describe("restart result rendering", () => {
  test("groups each service with both scopes under the quiet Restarted summary", () => {
    const output = renderRestartAppResult(result, decorated(80));
    const visible = stripAnsi(output);
    expect(visible.startsWith("\nRestarted\n  connection-demo ")).toBe(true);
    expect(visible).not.toMatch(/[╭╮╰╯├┤│─]/u);
    expect(visible).toContain("Services\n  web  running\n    Host        : https://demo.lndo.site/api, ");
    expect(visible).toContain("\n    App Network : http://web:3000\n");
    expect(visible).toContain(
      "\n  [SKIP] database  stopped\n    Host        : postgresql://lando@localhost:5432/appdb [inactive]\n",
    );
    expect(visible).toContain(
      "\n  migrate  completed\n    Host        : not published\n    App Network : -\n",
    );
    expect(visible).toContain("\nNext\n  lando info\n");
    expect(visible.trimEnd().endsWith("\n1 service ready; 1 completed; 1 stopped; 1 unknown")).toBe(true);
    for (const line of output.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  test("links only active host HTTP URLs", () => {
    const output = renderRestartAppResult(result, decorated(80));
    const targets = output
      .split("\x1b]8;;")
      .slice(1)
      .map((span) => span.split("\x1b\\")[0])
      .filter(Boolean);
    expect(targets).toEqual(["https://demo.lndo.site/api", "http://demo.lndo.site/api"]);
  });

  test("keeps service rows and field labels whole in a 36-column terminal", () => {
    const lines = stripAnsi(renderRestartAppResult(result, decorated(36))).split("\n");
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(36);
    expect(lines).toContain("  web  running");
    expect(lines).toContain("  [SKIP] database  stopped");
    expect(lines).toContain("  [INFO] 你好-worker  unknown");
    expect(lines).toContain("  migrate  completed");
    const fieldLabels = lines.flatMap((line) => {
      const match = /^ {4}(\S.*?) :/u.exec(line);
      return match?.[1] === undefined ? [] : [match[1].trimEnd()];
    });
    expect(new Set(fieldLabels)).toEqual(new Set(["Host", "App Network"]));
    expect(fieldLabels).toHaveLength(8);
    expect(lines.filter((line) => line.includes("App Net") && !line.includes("App Network :"))).toEqual([]);
  });

  test("summary carries the shared readiness verdict and tones", () => {
    const summary = buildRestartSummary(result);
    expect(summary.title).toBe("Restarted");
    expect(summary.tone).toBe("warn");
    expect(summary.footer).toBe("1 service ready; 1 completed; 1 stopped; 1 unknown");
    expect(summary.nextCommands).toEqual(["info", "logs", "exec"]);
    expect(summary.sections.map((section) => section.title)).toEqual(["Services"]);
    expect(summary.sections[0]?.rows.map((row) => [row.label, row.tone])).toEqual([
      ["web", "ok"],
      ["database", "skipped"],
      ["你好-worker", "info"],
      ["migrate", "ok"],
    ]);
  });

  test("reports an empty restart without inventing a service", () => {
    const summary = buildRestartSummary({ app: "empty", servicesStarted: [] });
    expect(summary.tone).toBe("info");
    expect(summary.sections[0]?.rows).toEqual([]);
    expect(summary.sections[0]?.notes).toHaveLength(1);
  });

  test.each([
    ["no context", undefined],
    ["lando renderer without a TTY", { ...decorated(80), isTTY: false }],
    ["plain renderer on a TTY", { ...decorated(80), mode: "plain" as const }],
  ])("preserves the plain lifecycle line with %s", (_name, ctx) => {
    const output = renderRestartAppResult(result, ctx);
    expect(output).toBe(plainLine);
    expect(output).not.toContain("\x1b");
  });
});
