import { expect, test } from "bun:test";
import type { StartAppResult } from "@lando/sdk/app";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";
import { connections } from "./connection-fixtures";

test("successful starts with restarting services use warning summaries without claiming complete readiness", () => {
  const result: StartAppResult = {
    app: "supervised",
    servicesStarted: [
      { name: "web", state: "ready", connections: connections(["http://web:3000"], "app") },
      { name: "worker", state: "restarting", connections: [] },
    ],
  };
  const summary = buildStartSummary(result);
  expect(summary.tone).toBe("warn");
  expect(summary.sections[1]?.rows[1]).toMatchObject({ label: "worker", value: "restarting", tone: "warn" });
  expect(summary.subtitle).not.toBe("supervised is ready");
  expect(summary.footer).toBe("1 service ready; 1 restarting");
  expect(renderStartAppResult(result)).toContain("worker (restarting)");
});

test("rebuild keeps its success heading but warns about restarting services", () => {
  const summary = buildStartSummary(
    {
      app: "supervised",
      servicesStarted: [{ name: "worker", state: "restarting", connections: [] }],
    },
    "rebuild",
  );
  expect(summary.title).toBe("Rebuilt");
  expect(summary.tone).toBe("warn");
  expect(summary.footer).toBe("0 services ready; 1 restarting");
});
