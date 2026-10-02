import { describe, expect, test } from "bun:test";

import { hyperlink, stripAnsi } from "@lando/renderer/console-layout";
import type { InfoAppResult } from "@lando/sdk/app";

import { renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";

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
      endpoints: ["https://my-app.lndo.site", "http://localhost:3000", "tcp://localhost:5432"],
    },
  ],
};

const tty = (env: Record<string, string | undefined> = { TERM: "xterm-256color" }): RenderContext => ({
  mode: "lando",
  format: "text",
  columns: 80,
  isTTY: true,
  env,
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
    const out = renderInfoAppResult(result, tty({ TERM: "xterm-256color", NO_COLOR: "1" }));
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps endpoints plain when TERM is dumb", () => {
    const out = renderInfoAppResult(result, tty({ TERM: "dumb" }));
    expect(out).toContain("https://my-app.lndo.site");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps endpoints plain when env is missing on a TTY context", () => {
    const out = renderInfoAppResult(result, {
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: true,
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
          endpoints: [longUrl],
        },
      ],
    };
    const out = renderInfoAppResult(narrow, { ...tty(), columns: 36 });
    expect(out).not.toContain(`${ESC}]8;;${longUrl}`);
    expect(out).not.toContain(`${ESC}]8;`);
    const visible = stripAnsi(out);
    expect(visible).toContain("https://example.co");
    expect(visible).toContain("ss/columns");
    expect(visible).not.toContain(longUrl);
  });
});
