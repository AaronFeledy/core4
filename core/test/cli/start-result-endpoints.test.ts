import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { StartAppResult } from "@lando/sdk/app";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";

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
      endpoints: [
        "http://my-app.lndo.site",
        "https://my-app.lndo.site",
        "http://localhost:3000",
        "tcp://localhost:5432",
      ],
    },
  ],
};

const nearMissResult: StartAppResult = {
  app: "my-app",
  servicesStarted: [
    {
      name: "web",
      state: "running",
      endpoints: [
        "http://example.com/app",
        "https://example.com/app/",
        "https://example.com/other",
        "http://example.com:8080/app",
      ],
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

  test("keeps 36-column wrapping with linked url rows", () => {
    expectQuiet(renderStartAppResult(counterpartResult, decorated(36)), 36);
  });

  test("plain and non-TTY output contain no OSC and keep the one-liner", () => {
    const expected =
      "ready: my-app - web (running) http://my-app.lndo.site, https://my-app.lndo.site, http://localhost:3000, tcp://localhost:5432";
    const plain = renderStartAppResult(counterpartResult);
    const nonTty = renderStartAppResult(counterpartResult, {
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
