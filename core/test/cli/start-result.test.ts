import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { StartAppResult } from "@lando/sdk/app";
import { startSpec } from "../../src/cli/command-specs/app/start.ts";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";

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
    { name: "web", state: "running", endpoints: ["http://localhost:3000", "https://my-app.lndo.site"] },
    { name: "database", state: "ready", endpoints: ["tcp://localhost:5432"] },
  ],
};

const mixedResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    { name: "web", state: "running", endpoints: ["http://localhost:3000"] },
    { name: "database", state: "stopped", endpoints: ["tcp://localhost:5432"] },
  ],
};

const emptyResult: StartAppResult = { app: "my-app", servicesStarted: [] };

const duplicateResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    { name: "web", state: "running", endpoints: ["http://localhost:3000", "https://my-app.lndo.site"] },
    { name: "api", state: "running", endpoints: ["http://localhost:3000", "http://localhost:8080"] },
  ],
};

const cjkResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    { name: "你好世界-web", state: "running", endpoints: ["http://localhost:3000"] },
    { name: "데이터베이스", state: "ready", endpoints: [] },
  ],
};

const oneReadyResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [{ name: "web", state: "running", endpoints: ["http://localhost:3000"] }],
};

const failedResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [{ name: "web", state: "failed", endpoints: [] }],
};

const unknownResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [{ name: "web", state: "created", endpoints: [] }],
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
        "URLs",
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
        "  lando exec -- <cmd>",
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

describe("renderStartAppResult decorated degraded", () => {
  test("renders a quiet partial summary when any service is not ready", () => {
    const out = renderStartAppResult(mixedResult, decorated());
    expectQuiet(out, 80);
    const plain = visible(out);
    expect(plain).toBe(
      [
        "",
        "Not fully ready",
        "  my-app is not fully ready",
        "",
        "URLs",
        "  http://localhost:3000",
        "  tcp://localhost:5432",
        "",
        "Services",
        "  web  running",
        "  [SKIP] database  stopped",
        "",
        "Next",
        "  lando info",
        "  lando logs",
        "",
        "1 of 2 services ready",
      ].join("\n"),
    );
    expect(plain).not.toContain("lando exec -- <cmd>");
    expect(out).not.toContain("[OK]");
  });

  test("notes an empty service list instead of celebrating", () => {
    const out = renderStartAppResult(emptyResult, decorated());
    expectQuiet(out, 80);
    const plain = visible(out);
    expect(plain).toContain("Not fully ready");
    expect(plain).toContain("my-app is not fully ready");
    expect(plain).not.toContain("Started");
    expect(plain).toContain("No services were started.");
    expect(plain).toContain("No published endpoints.");
    expect(plain).toContain("0 of 0 services ready");
  });

  test("maps failed service state to error tone and singular degraded footer", () => {
    const summary = buildStartSummary(failedResult);
    expect(summary.tone).toBe("error");
    expect(summary.sections[1]?.rows[0]?.tone).toBe("error");
    expect(summary.footer).toBe("0 of 1 service ready");
    const plain = visible(renderStartAppResult(failedResult, decorated()));
    expect(plain).toContain("[FAIL]");
    expect(plain).toContain("0 of 1 service ready");
  });

  test("maps unknown non-ready state to warn so it cannot look neutral", () => {
    const summary = buildStartSummary(unknownResult);
    expect(summary.tone).toBe("warn");
    expect(summary.sections[1]?.rows[0]?.tone).toBe("warn");
    const plain = visible(renderStartAppResult(unknownResult, decorated()));
    expect(plain).toContain("[WARN]");
    expect(plain).not.toContain("[INFO]");
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
    expect(summary.title).toBe("Started");
    expect(summary.subtitle).toBe("my-app is ready");
    expect(summary.sections.map((section) => section.title)).toEqual(["URLs", "Services"]);
  });

  test("uses Not fully ready when any service is not ready", () => {
    const summary = buildStartSummary(mixedResult);
    expect(summary.title).toBe("Not fully ready");
    expect(summary.subtitle).toBe("my-app is not fully ready");
  });
});

describe("renderStartAppResult non-decorated compatibility", () => {
  test("keeps the ready: one-liner without context", () => {
    expect(renderStartAppResult(readyResult)).toBe(
      "ready: my-app - web (running) http://localhost:3000, https://my-app.lndo.site; database (ready) tcp://localhost:5432",
    );
  });

  test("keeps the starting: one-liner for mixed states", () => {
    expect(renderStartAppResult(mixedResult)).toBe(
      "starting: my-app - web (running) http://localhost:3000; database (stopped) tcp://localhost:5432",
    );
  });

  test("keeps the starting: one-liner when no services started", () => {
    expect(renderStartAppResult(emptyResult)).toBe("starting: my-app");
  });

  test("stays a plain line in non-TTY lando mode", () => {
    const out = renderStartAppResult(readyResult, {
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: false,
    });
    expect(out).toBe(
      "ready: my-app - web (running) http://localhost:3000, https://my-app.lndo.site; database (ready) tcp://localhost:5432",
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
