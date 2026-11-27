import { describe, expect, test } from "bun:test";
import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { InfoAppResult, StartAppResult } from "@lando/sdk/app";
import { PortNumber, type ServiceConnection, type ServiceRoute, type ServiceState } from "@lando/sdk/schema";
import { connectionText, routeText } from "../../src/cli/commands/connection-summary";
import { renderInfoAppResult } from "../../src/cli/commands/info-render";
import { renderGlobalInfoResult } from "../../src/cli/commands/meta/global-info";
import { renderGlobalStatusResult } from "../../src/cli/commands/meta/global-status";
import { renderRebuildAppResult } from "../../src/cli/commands/rebuild";
import { renderRestartAppResult } from "../../src/cli/commands/restart";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result";
import type { RenderContext } from "../../src/cli/renderer-boundary";
import { connections, routeRow } from "./connection-fixtures";

const pending: ServiceRoute = {
  protocol: "https",
  host: "pending.test",
  hostMatch: "exact",
  pathPrefix: "/api",
  endpoint: { port: PortNumber.make(3000), transport: "tcp", names: ["web"], primary: true },
  binding: "pending",
  state: "inactive",
};
const inventory: readonly ServiceConnection[] = [
  ...connections(["https://inactive.test"], "host", "inactive"),
  ...connections(["https://unknown.test"], "host", "unknown"),
  ...connections(["http://web:3000"], "app"),
  ...connections(["tcp://localhost:5432", "http://localhost:3000"]),
  {
    scope: "host",
    source: "publication",
    protocol: "tcp",
    host: "127.0.0.1",
    endpoint: pending.endpoint,
    binding: "pending",
    state: "unknown",
  },
];
const routes: readonly ServiceRoute[] = [
  routeRow({
    host: "active.test",
    protocol: "https",
    port: 443,
    pathPrefix: "",
    hostMatch: "exact",
    url: "https://active.test",
  }),
  routeRow({ host: "*.wild.test", protocol: "https", port: 443, pathPrefix: "", hostMatch: "pattern" }),
  pending,
];
const started: StartAppResult = {
  app: "demo",
  servicesStarted: [{ name: "web", state: "running", connections: inventory, routes }],
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
      routes,
    },
  ],
};
const tty: RenderContext = {
  mode: "lando",
  format: "text",
  isTTY: true,
  columns: 160,
  noColor: false,
};
const renderers = {
  info: (ctx: RenderContext) => renderInfoAppResult(info, ctx),
  start: (ctx: RenderContext) => renderStartAppResult(started, ctx),
  rebuild: (ctx: RenderContext) => renderRebuildAppResult({ ...started, servicesRebuilt: ["web"] }, ctx),
  restart: (ctx: RenderContext) => renderRestartAppResult(started, ctx),
  global: (ctx: RenderContext) =>
    renderGlobalStatusResult(
      {
        ...info,
        materialized: true,
        policyState: "available",
        runtimeState: "available",
        pending: [],
        diagnostics: [],
        services: info.services.map((service) => ({ ...service, desired: "enabled", pending: [] })),
      },
      "table",
      ctx,
    ),
};

describe("typed connection rendering", () => {
  test("global info reports route patterns without suggesting user-app open", () => {
    const output = stripAnsi(renderGlobalInfoResult({ ...info, app: "global" }, tty));
    expect(output).toContain("*.wild.test");
    expect(output).not.toContain("lando open");
  });

  test.each(Object.entries(renderers))(
    "%s retains unverified addresses and links only active host HTTP",
    (_name, render) => {
      // Given the same inventory across all result surfaces.
      const output = render(tty);
      // Then non-active addresses remain copyable, without becoming links.
      const plain = stripAnsi(output);
      expect(plain).toContain("https://inactive.test [inactive]");
      expect(plain).toContain("https://unknown.test [unknown]");
      expect(plain).toContain("*.wild.test [https pattern]");
      expect(plain).toContain("pending.test/api");
      expect(plain).toContain("not published");
      expect(plain).toContain("http://web:3000");
      const targets = output
        .split("\x1b]8;;")
        .slice(1)
        .map((span) => span.split("\x1b\\")[0])
        .filter(Boolean);
      expect(targets.sort()).toEqual(["http://localhost:3000", "https://active.test"]);
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
    expect(output).toContain("Host: https://inactive.test");
    expect(output).toContain("https://inactive.test [inactive]");
    expect(output).toContain(
      "http://localhost:3000, 127.0.0.1 → 3000/tcp [pending · not published; unknown], https://active.test",
    );
    expect(output).toContain("Route patterns: *.wild.test [https pattern]");
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

  test("an assigned inactive pattern preserves its configured port, prefix, and state", () => {
    const row = routeRow(
      { host: "*.app.lndo.site", protocol: "https", port: 8443, pathPrefix: "/hello", hostMatch: "pattern" },
      "inactive",
    );
    expect(routeText(row)).toBe("*.app.lndo.site:8443/hello [https pattern; inactive]");
  });

  test("start keeps both schemes of a pending pattern without inventing a router port or URL", () => {
    const address = {
      ...pending,
      host: "*.app.lndo.site",
      hostMatch: "pattern",
      pathPrefix: "/hello",
      endpoint: { ...pending.endpoint, port: PortNumber.make(8080) },
    } as const;
    const summary = buildStartSummary({
      app: "demo",
      servicesStarted: [
        {
          name: "web",
          state: "running",
          connections: [],
          routes: [{ ...address, protocol: "http" }, address],
        },
      ],
    });

    expect(summary.sections.map((section) => section.title)).toEqual(["Route patterns", "Services"]);
    expect(summary.sections[0]?.rows).toEqual([
      { label: "*.app.lndo.site/hello → 8080/tcp [https pattern; pending · not published; inactive]" },
      { label: "*.app.lndo.site/hello → 8080/tcp [http pattern; pending · not published; inactive]" },
    ]);
  });

  test("info never links an app URI identical to an active host URI", () => {
    const url = "http://same.test:3000";
    const output = renderInfoAppResult(
      {
        app: info.app,
        services: info.services.map((service) => ({
          ...service,
          connections: [...connections([url]), ...connections([url], "app")],
          routes: [],
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
      servicesStarted: [{ name: "web", state, connections: [], routes: [] }],
    };
    const summary = buildStartSummary(result);
    expect(summary.footer).toBe(`0 services ready; 1 ${state}`);
    expect(summary.subtitle).not.toBe("demo is ready");
    expect(summary.tone).not.toBe("ok");
    expect(renderStartAppResult(result).startsWith("started:")).toBe(true);
  });
});
