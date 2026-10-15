import { expect, test } from "bun:test";
import { buildStartSummary, renderStartAppResult } from "../../src/cli/commands/start-result.ts";

test("successful starts with restarting services use warning summaries without claiming complete readiness", () => {
  const result = {
    app: "supervised",
    servicesStarted: [
      { name: "web", state: "ready", endpoints: [] },
      { name: "worker", state: "restarting", endpoints: [] },
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
    { app: "supervised", servicesStarted: [{ name: "worker", state: "restarting", endpoints: [] }] },
    "rebuild",
  );
  expect(summary.title).toBe("Rebuilt");
  expect(summary.tone).toBe("warn");
  expect(summary.footer).toBe("0 services ready; 1 restarting");
});
