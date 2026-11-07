import { describe, expect, test } from "bun:test";

import { hyperlink, stripAnsi } from "@lando/renderer/console-layout";
import type { InfoAppResult } from "@lando/sdk/app";

import { renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";
import { connections } from "./connection-fixtures";

const ESC = String.fromCharCode(27);

const result: InfoAppResult = {
  app: "my-app",
  services: [
    {
      app: "my-app",
      service: "web",
      api: 4,
      type: "node",
      provider: "lando",
      primary: true,
      status: "running",
      connections: [
        ...connections(["https://my-app.lndo.site", "http://localhost:3000", "tcp://localhost:5432"]),
        ...connections(["http://web:3000"], "app"),
      ],
    },
  ],
};

const tty = (noColor = false): RenderContext => ({
  mode: "lando",
  format: "text",
  columns: 80,
  isTTY: true,
  noColor,
});

describe("renderInfoAppResult URL hyperlinks", () => {
  test("wraps printed http(s) endpoints in OSC 8 on a capable TTY", () => {
    const out = renderInfoAppResult(result, tty());
    expect(out).toContain(hyperlink("https://my-app.lndo.site", "https://my-app.lndo.site"));
    expect(out).toContain(hyperlink("http://localhost:3000", "http://localhost:3000"));
    expect(out).toContain("tcp://localhost:5432");
    expect(out).not.toContain(`${ESC}]8;;tcp://`);
    expect(stripAnsi(out)).toContain("https://my-app.lndo.site");
    expect(stripAnsi(out)).toContain("http://localhost:3000");
  });

  test("prints an app-network HTTP address without a host hyperlink", () => {
    // Given a service whose app-network listener speaks HTTP.
    const out = renderInfoAppResult(result, tty());
    // When painted on a capable TTY, then only host URLs are OSC 8 links.
    expect(out).not.toContain(`${ESC}]8;;http://web:3000`);
    expect(out).toContain(hyperlink("http://localhost:3000", "http://localhost:3000"));
    const visible = stripAnsi(out);
    expect(visible).toContain("http://web:3000");
    expect(visible.indexOf("App Network")).toBeGreaterThan(visible.indexOf("Host"));
  });

  test("keeps endpoints plain when stdout is not a TTY", () => {
    const out = renderInfoAppResult(result, { ...tty(), isTTY: false });
    expect(out).toBe(renderInfoAppResult(result));
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps endpoints plain under the plain renderer on a TTY", () => {
    const out = renderInfoAppResult(result, { ...tty(), mode: "plain" });
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps endpoints plain when NO_COLOR is set", () => {
    const out = renderInfoAppResult(result, tty(true));
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
    expect(out).not.toMatch(
      new RegExp(`${ESC}\\[(?:\\d+;)*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38;[\\d;]+|48;[\\d;]+)(?:;\\d+)*m`, "u"),
    );
    expect(stripAnsi(out)).toBe(stripAnsi(renderInfoAppResult(result, tty())));
  });

  test("keeps endpoints plain when TERM is dumb", () => {
    const out = renderInfoAppResult(result, tty(true));
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps endpoints plain when injected IO opts out on a TTY context", () => {
    const out = renderInfoAppResult(result, {
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: true,
      noColor: true,
    });
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("leaves a wrapped URL plain at a narrow column width", () => {
    const longUrl = "https://example.com/very/long/path/that/must/wrap/across/columns";
    const narrow: InfoAppResult = {
      app: "my-app",
      services: [
        {
          app: "my-app",
          service: "web",
          api: 4,
          type: "node",
          provider: "lando",
          primary: true,
          status: "running",
          connections: connections([longUrl]),
        },
      ],
    };
    const out = renderInfoAppResult(narrow, { ...tty(), columns: 36 });
    expect(out).not.toContain(`${ESC}]8;;${longUrl}`);
    expect(out).not.toContain(`${ESC}]8;`);
    const visible = stripAnsi(out);
    expect(visible).toContain("https://example.");
    expect(visible).toContain("ss/columns");
    expect(visible).not.toContain(longUrl);
  });

  test("leaves a framed wrapped head plain when another service owns the shorter prefix", () => {
    const shortUrl = "http://localhost:80";
    const longUrl = "http://localhost:8080/very/long/extra/path";
    const service = (name: string, endpoints: ReadonlyArray<string>): InfoAppResult["services"][number] => ({
      app: "my-app",
      service: name,
      api: 4,
      type: "node",
      provider: "lando",
      primary: true,
      status: "running",
      connections: connections(endpoints),
    });
    const out = renderInfoAppResult(
      { app: "my-app", services: [service("web", [shortUrl]), service("api", [longUrl])] },
      { ...tty(), columns: 37 },
    );
    const visible = stripAnsi(out);
    expect(visible).toContain(shortUrl);
    expect(visible).not.toContain(longUrl);
    expect(out).toContain(hyperlink(shortUrl, shortUrl));
    expect(out).not.toContain(`${ESC}]8;;${longUrl}`);
    const hrefs = [...out.matchAll(new RegExp(`${ESC}\\]8;;(.*?)(?:${ESC}\\\\|\\x07)`, "g"))]
      .map((match) => match[1] ?? "")
      .filter((href) => href.length > 0);
    expect(hrefs).toEqual([shortUrl]);
  });
});
