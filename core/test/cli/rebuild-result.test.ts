import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { RebuildAppResult } from "@lando/sdk/app";
import { renderRebuildAppResult } from "../../src/cli/commands/rebuild.ts";
import type { RenderContext } from "../../src/cli/renderer-boundary.ts";

const result: RebuildAppResult = {
  app: "windows-cms-final",
  servicesRebuilt: ["appserver", "database"],
  servicesStarted: [
    {
      name: "appserver",
      state: "running",
      endpoints: ["https://windows-cms-final.lndo.site:444", "http://windows-cms-final.lndo.site:8080"],
    },
    { name: "database", state: "running", endpoints: [] },
  ],
};

const decorated: RenderContext = { mode: "lando", format: "text", columns: 80, isTTY: true };

describe("rebuild result rendering", () => {
  test("uses the start-style quiet summary with a Rebuilt heading in a narrow terminal", () => {
    const output = renderRebuildAppResult(result, decorated);
    const visible = stripAnsi(output);
    expect(visible).toContain("\nRebuilt\n  windows-cms-final is ready");
    expect(visible).toContain("URLs\n");
    expect(visible).toContain("https://windows-cms-final.lndo.site:444");
    expect(visible).toContain("Services\n  appserver  running\n  database  running");
    expect(visible).toContain("Next\n  lando info");
    expect(visible).not.toContain("no endpoints");
    for (const line of output.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  test("preserves plain text for non-TTY output", () => {
    expect(renderRebuildAppResult(result)).toBe(
      "rebuilt: windows-cms-final - appserver (running) https://windows-cms-final.lndo.site:444, http://windows-cms-final.lndo.site:8080; database (running) no endpoints",
    );
  });
});
