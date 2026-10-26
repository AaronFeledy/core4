import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { StartAppResult } from "@lando/sdk/app";
import { startSpec } from "../../src/cli/command-specs/app/start.ts";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

const ESC = String.fromCharCode(27);
const PINK = `${ESC}[95m`;
const GREEN = `${ESC}[32m`;

const expectQuiet = (text: string, width: number): void => {
  expect(text.startsWith("\n")).toBe(true);
  expect(text.startsWith("\n\n")).toBe(false);
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
  const visible = stripAnsi(text);
  expect(visible).not.toMatch(/[╭╮╰╯├┤│─]/u);
  expect(text).not.toContain(PINK);
  expect(text).not.toContain("BOOMSHAKALAKA");
};

const visible = (text: string): string => stripAnsi(text);

const decorated = (columns = 80): RenderContext => ({
  mode: "lando",
  format: "text",
  columns,
  isTTY: true,
});

const readyResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: connections(["http://localhost:3000", "https://my-app.lndo.site"]),
    },
    { name: "database", state: "ready", connections: connections(["tcp://localhost:5432"]) },
  ],
};

const mixedResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    { name: "web", state: "running", connections: connections(["http://localhost:3000"]) },
    {
      name: "database",
      state: "completed",
      connections: connections(["tcp://localhost:5432"], "host", "inactive"),
    },
  ],
};

const emptyResult: StartAppResult = { app: "my-app", servicesStarted: [] };

const duplicateResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: connections(["http://localhost:3000", "https://my-app.lndo.site"]),
    },
    {
      name: "api",
      state: "running",
      connections: connections(["http://localhost:3000", "http://localhost:8080"]),
    },
  ],
};

const cjkResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "你好世界-web",
      state: "running",
      connections: [
        ...connections(["http://localhost:3000"]),
        ...connections(["http://你好世界-web:3000"], "app"),
      ],
    },
    { name: "데이터베이스", state: "ready", connections: connections(["tcp://데이터베이스:5432"], "app") },
  ],
};

const oneReadyResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [{ name: "web", state: "running", connections: connections(["http://localhost:3000"]) }],
};

// A moved database port: reachable from other services on the app network only.
const appNetworkResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: [...connections(["https://my-app.lndo.site"]), ...connections(["http://web:3000"], "app")],
    },
    { name: "db", state: "ready", connections: connections(["tcp://db:3307"], "app") },
    { name: "worker", state: "completed", connections: [] },
  ],
};

describe("renderStartAppResult decorated ready", () => {
  test("renders a quiet ready summary when every service is running or ready", () => {
    const out = renderStartAppResult(readyResult, decorated());
    expectQuiet(out, 80);
    const plain = visible(out);
    expect(plain).toBe(
      [
        "",
        "Started",
        "  my-app is ready",
        "",
        "Host",
        "  https://my-app.lndo.site",
        "  http://localhost:3000",
        "  tcp://localhost:5432",
        "",
        "Services",
        "  web  running",
        "  database  ready",
        "",
        "Next",
        "  lando info",
        "  lando logs",
        "  lando exec <service> -- <command>",
        "",
        "2 services ready",
      ].join("\n"),
    );
    expect(out).not.toContain("[OK]");
    expect(out).not.toContain(GREEN);
    expect(plain).not.toContain("STARTING");
    expect(plain).not.toContain("Not fully ready");
    expect(plain).not.toContain("endpoints");
  });

  test("lists unique published endpoints HTTPS-first then HTTP then other", () => {
    const out = visible(renderStartAppResult(duplicateResult, decorated()));
    const httpsUrl = out.indexOf("https://my-app.lndo.site");
    const http3000 = out.indexOf("http://localhost:3000");
    const http8080 = out.indexOf("http://localhost:8080");
    const services = out.indexOf("Services");
    expect(httpsUrl).toBeGreaterThan(-1);
    expect(http3000).toBeGreaterThan(httpsUrl);
    expect(http8080).toBeGreaterThan(http3000);
    expect(services).toBeGreaterThan(http8080);
    expect(out.split("http://localhost:3000").length - 1).toBe(1);
  });

  test("singularizes the ready footer for one service", () => {
    expect(buildStartSummary(oneReadyResult).footer).toBe("1 service ready");
    expect(visible(renderStartAppResult(oneReadyResult, decorated()))).toContain("1 service ready");
  });
});

describe("renderStartAppResult completed jobs", () => {
  test("renders completed jobs as a successful quiet summary", () => {
    const out = renderStartAppResult(mixedResult, decorated());
    expectQuiet(out, 80);
    const plain = visible(out);
    expect(plain).toBe(
      [
        "",
        "Started",
        "  my-app is ready",
        "",
        "Host",
        "  http://localhost:3000",
        "  tcp://localhost:5432 [inactive]",
        "",
        "Services",
        "  web  running",
        "  database  completed",
        "",
        "Next",
        "  lando info",
        "  lando logs",
        "  lando exec <service> -- <command>",
        "",
        "1 service ready; 1 completed",
      ].join("\n"),
    );
    expect(buildStartSummary(mixedResult).sections[1]?.rows[1]?.tone).toBe("ok");
    expect(out).not.toContain("[OK]");
  });

  test("notes an empty service list in a successful empty app", () => {
    const out = renderStartAppResult(emptyResult, decorated());
    expectQuiet(out, 80);
    const plain = visible(out);
    expect(plain).toContain("my-app is ready");
    expect(plain).toContain("Started");
    expect(plain).toContain("No services were started.");
    expect(plain).toContain("No published endpoints.");
    expect(plain).toContain("0 services ready");
  });

  test("uses successful rebuild output for completed jobs", () => {
    const summary = buildStartSummary(mixedResult, "rebuild");
    expect(summary.title).toBe("Rebuilt");
    expect(summary.tone).toBe("ok");
    expect(summary.footer).toBe("1 service ready; 1 completed");
  });
});

describe("buildStartSummary service rows", () => {
  test("omits per-service endpoint fields because URLs already list them", () => {
    const web = buildStartSummary(readyResult).sections[1]?.rows[0];
    expect(web?.fields).toBeUndefined();
    expect(web?.detail).toBeUndefined();
    expect(web?.label).toBe("web");
    expect(web?.value).toBe("running");
  });

  test("uses Started and URLs/Services labels when fully ready", () => {
    const summary = buildStartSummary(readyResult);
    expect(summary.nextCommands).toEqual(["info", "logs", "exec"]);
    expect(summary.nextSteps).toBeUndefined();
    expect(summary.title).toBe("Started");
    expect(summary.subtitle).toBe("my-app is ready");
    expect(summary.sections.map((section) => section.title)).toEqual(["Host", "Services"]);
  });

  test("uses Started when a job completed successfully", () => {
    const summary = buildStartSummary(mixedResult);
    expect(summary.nextCommands).toEqual(["info", "logs", "exec"]);
    expect(summary.nextSteps).toBeUndefined();
    expect(summary.title).toBe("Started");
    expect(summary.subtitle).toBe("my-app is ready");
  });
});

describe("renderStartAppResult app-network addresses", () => {
  test("lists app-network addresses under each service row, apart from host URLs", () => {
    const out = renderStartAppResult(appNetworkResult, decorated());
    expectQuiet(out, 80);
    expect(visible(out)).toBe(
      [
        "",
        "Started",
        "  my-app is ready",
        "",
        "Host",
        "  https://my-app.lndo.site",
        "",
        "Services",
        "  web  running",
        "    App Network : http://web:3000",
        "  db  ready",
        "    App Network : tcp://db:3307",
        "  worker  completed",
        "",
        "Next",
        "  lando info",
        "  lando logs",
        "  lando exec <service> -- <command>",
        "",
        "2 services ready; 1 completed",
      ].join("\n"),
    );
  });

  test("keeps an internal-only database out of the URL section", () => {
    const summary = buildStartSummary(appNetworkResult);
    expect(summary.sections[0]?.rows.map((row) => row.label)).toEqual(["https://my-app.lndo.site"]);
    expect(summary.sections[0]?.notes).toBeUndefined();
    expect(summary.sections[1]?.rows).toEqual([
      {
        label: "web",
        tone: "ok",
        value: "running",
        fields: [{ label: "App Network", value: "http://web:3000" }],
      },
      { label: "db", tone: "ok", value: "ready", fields: [{ label: "App Network", value: "tcp://db:3307" }] },
      { label: "worker", tone: "ok", value: "completed" },
    ]);
  });

  test("notes missing host URLs even when every service has an app-network address", () => {
    const summary = buildStartSummary({
      app: "my-app",
      servicesStarted: [{ name: "db", state: "ready", connections: connections(["tcp://db:3307"], "app") }],
    });
    expect(summary.sections[0]?.rows).toEqual([]);
    expect(summary.sections[0]?.notes).toEqual(["No published endpoints."]);
    expect(summary.sections[1]?.rows[0]?.fields).toEqual([{ label: "App Network", value: "tcp://db:3307" }]);
  });

  test("keeps the plain one-liner host-first with internal addresses after", () => {
    expect(renderStartAppResult(appNetworkResult)).toBe(
      "ready: my-app - web (running) Host: https://my-app.lndo.site App Network: http://web:3000; db (ready) App Network: tcp://db:3307; worker (completed) no endpoints",
    );
  });

  test("wraps app-network fields within a small terminal width", () => {
    expectQuiet(renderStartAppResult(appNetworkResult, decorated(36)), 36);
  });
});

describe("renderStartAppResult non-decorated compatibility", () => {
  test("keeps the ready: one-liner without context", () => {
    expect(renderStartAppResult(readyResult)).toBe(
      "ready: my-app - web (running) Host: http://localhost:3000, https://my-app.lndo.site; database (ready) Host: tcp://localhost:5432",
    );
  });

  test("uses ready: for running services and completed jobs", () => {
    expect(renderStartAppResult(mixedResult)).toBe(
      "ready: my-app - web (running) Host: http://localhost:3000; database (completed) Host: tcp://localhost:5432 [inactive]",
    );
  });

  test("uses ready: when an empty app succeeds", () => {
    expect(renderStartAppResult(emptyResult)).toBe("ready: my-app");
  });

  test("stays a plain line in non-TTY lando mode", () => {
    const out = renderStartAppResult(readyResult, {
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: false,
    });
    expect(out).toBe(
      "ready: my-app - web (running) Host: http://localhost:3000, https://my-app.lndo.site; database (ready) Host: tcp://localhost:5432",
    );
    expect(out).not.toContain("╭─");
  });

  test("stays a plain line in plain TTY mode", () => {
    const out = renderStartAppResult(readyResult, {
      mode: "plain",
      format: "text",
      columns: 80,
      isTTY: true,
    });
    expect(out.startsWith("ready: my-app")).toBe(true);
    expect(out).not.toContain("╭─");
  });
});

describe("renderStartAppResult wrapping", () => {
  test("stays within a small terminal width", () => {
    expectQuiet(renderStartAppResult(readyResult, decorated(36)), 36);
  });

  test("keeps CJK service names readable", () => {
    const out = renderStartAppResult(cjkResult, decorated(60));
    expectQuiet(out, 60);
    const plain = visible(out);
    expect(plain).toContain("你好世界-web");
    expect(plain).toContain("데이터베이스");
    expect(plain).toContain("Started");
  });
});

describe("startSpec render wiring", () => {
  test("passes RenderContext through to the quiet start summary", () => {
    const out = startSpec.render?.(readyResult, undefined, decorated(72));
    expect(out).toBeDefined();
    expectQuiet(out ?? "", 72);
    expect(visible(out ?? "")).toContain("Started");
  });
});
