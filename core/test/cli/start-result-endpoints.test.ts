import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { StartAppResult } from "@lando/sdk/app";
import { ServiceName } from "@lando/sdk/schema";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

const ESC = String.fromCharCode(27);
const ST = `${ESC}\\`;
const DIM = `${ESC}[2m`;
const PINK = `${ESC}[95m`;

const expectQuiet = (text: string, width: number): void => {
  expect(text.startsWith("\n")).toBe(true);
  expect(text.startsWith("\n\n")).toBe(false);
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
  expect(stripAnsi(text)).not.toMatch(/[╭╮╰╯├┤│─]/u);
  expect(text).not.toContain(PINK);
};

const decorated = (columns = 80): RenderContext => ({
  noColor: false,
  mode: "lando",
  format: "text",
  columns,
  isTTY: true,
});

const urlLine = (out: string, url: string): string => {
  const line = out.split("\n").find((row) => stripAnsi(row).includes(url));
  expect(line).toBeDefined();
  return line ?? "";
};

const counterpartResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: connections([
        "http://my-app.lndo.site",
        "https://my-app.lndo.site",
        "http://localhost:3000",
        "tcp://localhost:5432",
      ]),
    },
  ],
};

const nearMissResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      connections: connections([
        "http://example.com/app",
        "https://example.com/app/",
        "https://example.com/other",
        "http://example.com:8080/app",
      ]),
    },
  ],
};

describe("buildStartSummary url ranking and counterparts", () => {
  test("ranks unique urls HTTPS then HTTP then other and mutes exact HTTP counterparts", () => {
    // Given mixed-scheme endpoints with one exact HTTPS counterpart.
    const urls = buildStartSummary(counterpartResult).sections[0]?.rows;

    // When the start summary is built, then rank, href, and mute follow the counterpart rule.
    expect(urls).toEqual([
      { label: "https://my-app.lndo.site", href: "https://my-app.lndo.site" },
      { label: "http://my-app.lndo.site", href: "http://my-app.lndo.site", muted: true },
      { label: "http://localhost:3000", href: "http://localhost:3000" },
      { label: "tcp://localhost:5432" },
    ]);
  });

  test("does not mute HTTP urls that differ by path, slash, host, or port", () => {
    const urls = buildStartSummary(nearMissResult).sections[0]?.rows;
    expect(urls?.map((row) => row.label)).toEqual([
      "https://example.com/app/",
      "https://example.com/other",
      "http://example.com/app",
      "http://example.com:8080/app",
    ]);
    expect(urls?.every((row) => row.muted !== true)).toBe(true);
  });

  test("does not repeat endpoints on service rows", () => {
    const web = buildStartSummary(counterpartResult).sections[1]?.rows[0];
    expect(web?.fields).toBeUndefined();
    expect(web?.href).toBeUndefined();
    expect(web?.label).toBe("web");
    expect(web?.value).toBe("running");
  });
});

describe("renderStartAppResult endpoint hyperlinks", () => {
  test("keeps separate verdicts for routes sharing an authority", () => {
    const service = ServiceName.make("web");
    const urls = ["https://my-app.lndo.site/alpha", "https://my-app.lndo.site/beta"];
    const result: StartAppResult = {
      app: "my-app",
      servicesStarted: [{ name: service, state: "running", connections: connections(urls) }],
      checks: urls.map((url, index) => ({
        id: `http:web:${url}/health`,
        kind: "http",
        service,
        url: `${url}/health`,
        verdict: index === 0 ? "ready" : "app-error",
        statusCode: index === 0 ? 200 : 500,
      })),
    };
    expect(buildStartSummary(result).sections[0]?.rows.map((row) => row.label)).toEqual([
      "https://my-app.lndo.site/alpha 200",
      "https://my-app.lndo.site/beta 500 from your app",
    ]);
  });
  test("gives a route the verdict of its own check, not a longer sibling route's", () => {
    // Given: /api/v2's check is listed first and also starts with /api's prefix.
    const service = ServiceName.make("web");
    const urls = ["https://my-app.lndo.site/api", "https://my-app.lndo.site/api/v2"];
    const result: StartAppResult = {
      app: "my-app",
      servicesStarted: [{ name: service, state: "running", connections: connections(urls) }],
      checks: [
        {
          id: `http:web:${urls[1]}/`,
          kind: "http",
          service,
          url: `${urls[1]}/`,
          verdict: "app-error",
          statusCode: 500,
        },
        {
          id: `http:web:${urls[0]}/`,
          kind: "http",
          service,
          url: `${urls[0]}/`,
          verdict: "ready",
          statusCode: 200,
        },
      ],
    };
    // When/Then: each URL row shows its own status.
    expect(buildStartSummary(result).sections[0]?.rows.map((row) => row.label)).toEqual([
      "https://my-app.lndo.site/api 200",
      "https://my-app.lndo.site/api/v2 500 from your app",
    ]);
  });
  test.each([
    ["ready", 200, " 200"],
    ["app-error", 500, " 500 from your app"],
    ["service-error", 502, " 502 from the web server"],
    ["lando-error", undefined, " unreachable"],
  ] as const)("renders %s URL check status without changing plain output", (verdict, statusCode, suffix) => {
    const url = "https://my-app.lndo.site";
    const result: StartAppResult = {
      ...counterpartResult,
      checks: [
        {
          id: `http:web:${url}/health`,
          kind: "http",
          service: ServiceName.make("web"),
          url: `${url}/health`,
          verdict,
          ...(statusCode === undefined ? {} : { statusCode }),
        },
      ],
    };
    const output = renderStartAppResult(result, decorated(120));
    expect(stripAnsi(urlLine(output, url))).toContain(`${url}${suffix}`);
    expect(buildStartSummary(result).sections[0]?.title).toBe("Host");
    expect(renderStartAppResult(result)).toBe(renderStartAppResult(counterpartResult));
  });
  test("decorates HTTP and HTTPS url rows with OSC 8 and dims only the counterpart", () => {
    // Given a decorated TTY start summary with an exact HTTPS counterpart.
    const out = renderStartAppResult(counterpartResult, decorated());
    expectQuiet(out, 80);

    // When url rows are painted, then HTTP/HTTPS are linked and only the counterpart is dim.
    const httpsLine = urlLine(out, "https://my-app.lndo.site");
    const httpCounterpart = urlLine(out, "http://my-app.lndo.site");
    const httpUnrelated = urlLine(out, "http://localhost:3000");
    const tcpLine = urlLine(out, "tcp://localhost:5432");
    expect(httpsLine).toContain(`${ESC}]8;;https://my-app.lndo.site${ST}`);
    expect(httpCounterpart).toContain(`${ESC}]8;;http://my-app.lndo.site${ST}`);
    expect(httpUnrelated).toContain(`${ESC}]8;;http://localhost:3000${ST}`);
    expect(tcpLine).not.toContain(`${ESC}]8;`);
    expect(httpCounterpart).toContain(DIM);
    expect(httpsLine).not.toContain(DIM);
    expect(httpUnrelated).not.toContain(DIM);
    expect(tcpLine).not.toContain(DIM);
  });

  test("never turns an app-network HTTP address into a host hyperlink", () => {
    // Given a service whose app-network listener is HTTP and whose host URL is routed.
    const result: StartAppResult = {
      app: "my-app",
      servicesStarted: [
        {
          name: "web",
          state: "running",
          connections: [
            ...connections(["https://my-app.lndo.site"]),
            ...connections(["http://web:3000"], "app"),
          ],
        },
      ],
    };
    const out = renderStartAppResult(result, decorated());
    expectQuiet(out, 80);

    // When the summary is painted, then only the host URL is linked and the
    // app-network address sits under its service, after the URL section.
    expect(urlLine(out, "https://my-app.lndo.site")).toContain(`${ESC}]8;;https://my-app.lndo.site${ST}`);
    expect(urlLine(out, "http://web:3000")).not.toContain(`${ESC}]8;`);
    expect(out).not.toContain(`${ESC}]8;;http://web:3000`);
    const plain = stripAnsi(out);
    expect(plain.indexOf("http://web:3000")).toBeGreaterThan(plain.indexOf("Services"));
    expect(buildStartSummary(result).sections[0]?.rows.map((row) => row.label)).toEqual([
      "https://my-app.lndo.site",
    ]);
  });

  test("keeps 36-column wrapping with linked url rows", () => {
    expectQuiet(renderStartAppResult(counterpartResult, decorated(36)), 36);
  });

  test("plain and non-TTY output contain no OSC and keep the one-liner", () => {
    const expected =
      "ready: my-app - web (running) Host: http://my-app.lndo.site, https://my-app.lndo.site, http://localhost:3000, tcp://localhost:5432";
    const plain = renderStartAppResult(counterpartResult);
    const nonTty = renderStartAppResult(counterpartResult, {
      noColor: false,
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: false,
    });
    expect(plain).toBe(expected);
    expect(nonTty).toBe(expected);
    expect(plain).not.toContain(`${ESC}]8;`);
    expect(nonTty).not.toContain(`${ESC}]8;`);
    expect(plain).not.toContain(ESC);
    expect(nonTty).not.toContain(ESC);
  });
});
