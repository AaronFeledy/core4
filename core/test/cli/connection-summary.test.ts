import { describe, expect, test } from "bun:test";
import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { InfoAppResult, StartAppResult } from "@lando/sdk/app";
import { PortNumber, type ServiceConnection, type ServiceState } from "@lando/sdk/schema";
import { connectionText } from "../../src/cli/commands/connection-summary";
import { renderInfoAppResult } from "../../src/cli/commands/info-render";
import { renderGlobalStatusResult } from "../../src/cli/commands/meta/global-status";
import { renderRebuildAppResult } from "../../src/cli/commands/rebuild";
import { renderRestartAppResult } from "../../src/cli/commands/restart";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result";
import type { RenderContext } from "../../src/cli/renderer-boundary";
import { connections } from "./connection-fixtures";

const pending: ServiceConnection = {
  scope: "host",
  source: "route",
  protocol: "https",
  host: "pending.test",
  pathPrefix: "/api",
  endpoint: { port: PortNumber.make(3000), transport: "tcp", names: ["web"], primary: true },
  binding: "pending",
  state: "inactive",
};
const inventory: readonly ServiceConnection[] = [
  ...connections(["https://active.test"]),
  ...connections(["https://inactive.test"], "host", "inactive"),
  ...connections(["https://unknown.test"], "host", "unknown"),
  ...connections(["https://*.wild.test"]),
  ...connections(["http://web:3000"], "app"),
  pending,
];
const started: StartAppResult = {
  app: "demo",
  servicesStarted: [{ name: "web", state: "running", connections: inventory }],
};
const info: InfoAppResult = {
  app: "demo",
  services: [
    {
      app: "demo",
      service: "web",
      api: 4,
      type: "node",
      provider: "lando",
      primary: true,
      status: "running",
      connections: inventory,
    },
  ],
};
const tty: RenderContext = {
  mode: "lando",
  format: "text",
  isTTY: true,
  columns: 80,
  env: { TERM: "xterm-256color" },
};
const renderers = {
  info: (ctx: RenderContext) => renderInfoAppResult(info, ctx),
  start: (ctx: RenderContext) => renderStartAppResult(started, ctx),
  rebuild: (ctx: RenderContext) => renderRebuildAppResult({ ...started, servicesRebuilt: ["web"] }, ctx),
  restart: (ctx: RenderContext) => renderRestartAppResult(started, ctx),
  global: (ctx: RenderContext) => renderGlobalStatusResult({ ...info, materialized: true }, "table", ctx),
};

describe("typed connection rendering", () => {
  test.each(Object.entries(renderers))(
    "%s retains unverified addresses and links only active host HTTP",
    (_name, render) => {
      // Given the same inventory across all result surfaces.
      const output = render(tty);
      // Then non-active addresses remain copyable, without becoming links.
      const plain = stripAnsi(output);
      expect(plain).toContain("https://inactive.test [inactive]");
      expect(plain).toContain("https://unknown.test [unknown]");
      expect(plain).toContain("pending.test/api");
      expect(plain).toContain("not published");
      expect(plain).toContain("http://web:3000");
      const targets = output
        .split("\x1b]8;;")
        .slice(1)
        .map((span) => span.split("\x1b\\")[0])
        .filter(Boolean);
      expect(targets).toEqual(["https://active.test"]);
    },
  );

  test.each(Object.entries(renderers))(
    "%s fits a 36-column terminal without dropping pending intent",
    (_name, render) => {
      const output = render({ ...tty, columns: 36 });
      for (const line of output.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(36);
      expect(stripAnsi(output)).toContain("pending");
    },
  );

  test("restart without a decorated context retains both scopes and observation labels", () => {
    const output = renderRestartAppResult(started);
    expect(output).toContain("Host: https://active.test");
    expect(output).toContain("https://inactive.test [inactive]");
    expect(output).toContain("App Network: http://web:3000");
    expect(output).not.toContain("\x1b");
  });

  test("pending publication reports the logical listener without fabricating a URL", () => {
    const publication: ServiceConnection = {
      scope: "host",
      source: "publication",
      protocol: "tcp",
      host: "127.0.0.1",
      endpoint: pending.endpoint,
      binding: "pending",
      state: "unknown",
    };
    const output = connectionText(publication);
    expect(output).toContain("127.0.0.1 → 3000/tcp");
    expect(output).toContain("pending");
    expect(output).toContain("unknown");
    expect(output).not.toContain("://");
    expect(output).not.toContain(":0");
  });

  test("info never links an app URI identical to an active host URI", () => {
    const url = "http://same.test:3000";
    const output = renderInfoAppResult(
      {
        app: info.app,
        services: info.services.map((service) => ({
          ...service,
          connections: [...connections([url]), ...connections([url], "app")],
        })),
      },
      tty,
    );
    expect(stripAnsi(output).split(url)).toHaveLength(3);
    expect(output).not.toContain("\x1b]8;");
  });

  test.each([
    "unknown",
    "stopped",
    "starting",
    "unhealthy",
    "restarting",
    "paused",
    "error",
  ] satisfies ServiceState[])("does not count %s as ready", (state) => {
    const result: StartAppResult = {
      app: "demo",
      servicesStarted: [{ name: "web", state, connections: [] }],
    };
    const summary = buildStartSummary(result);
    expect(summary.footer).toBe(`0 services ready; 1 ${state}`);
    expect(summary.subtitle).not.toBe("demo is ready");
    expect(summary.tone).not.toBe("ok");
    expect(renderStartAppResult(result).startsWith("started:")).toBe(true);
  });
});
