import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

import { hyperlink, stripAnsi } from "@lando/renderer/console-layout";

import { type ListServicesResult, renderAppsListResult } from "../../src/cli/commands/list.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";

const ESC = String.fromCharCode(27);

const result: ListServicesResult = {
  apps: [
    {
      appId: "my-app",
      appName: "my-app",
      providerId: "lando",
      appRoot: "/srv/apps/my-app",
      services: ["web"],
      status: "active",
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

describe("renderAppsListResult ROOT hyperlinks", () => {
  test("wraps the printed absolute ROOT in a file OSC 8 link on a capable TTY", () => {
    const out = renderAppsListResult(result, "table", tty());
    const href = pathToFileURL("/srv/apps/my-app").href;
    expect(out).toContain(hyperlink("/srv/apps/my-app", href));
    expect(stripAnsi(out)).toContain("/srv/apps/my-app");
    expect(stripAnsi(out)).toContain("ROOT");
    expect(out).not.toContain("vscode://");
  });

  test("keeps ROOT plain when stdout is not a TTY", () => {
    const out = renderAppsListResult(result, "table", {
      ...tty(),
      isTTY: false,
    });
    expect(out).toContain("/srv/apps/my-app");
    expect(out).not.toContain(`${ESC}]8;`);
    expect(out).toBe(renderAppsListResult(result));
  });

  test("keeps ROOT plain under the plain renderer on a TTY", () => {
    const out = renderAppsListResult(result, "table", { ...tty(), mode: "plain" });
    expect(out).toContain("/srv/apps/my-app");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps ROOT plain when NO_COLOR is set", () => {
    const out = renderAppsListResult(result, "table", tty({ TERM: "xterm-256color", NO_COLOR: "1" }));
    expect(out).toContain("/srv/apps/my-app");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps ROOT plain when TERM is dumb", () => {
    const out = renderAppsListResult(result, "table", tty({ TERM: "dumb" }));
    expect(out).toContain("/srv/apps/my-app");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps ROOT plain when env is missing on a TTY context", () => {
    const out = renderAppsListResult(result, "table", {
      mode: "lando",
      format: "text",
      columns: 80,
      isTTY: true,
    });
    expect(out).toContain("/srv/apps/my-app");
    expect(out).not.toContain(`${ESC}]8;`);
  });

  test("keeps ROOT plain when the printed path contains C0", () => {
    const dirty = {
      apps: [
        {
          appId: "my-app",
          appName: "my-app",
          providerId: "lando",
          appRoot: "/srv/apps/my-app\u0007x",
          services: ["web"],
          status: "active" as const,
        },
      ],
    };
    const out = renderAppsListResult(dirty, "table", tty());
    expect(out).toContain("/srv/apps/my-app\u0007x");
    expect(out).not.toContain(`${ESC}]8;`);
  });
});
