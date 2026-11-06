import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, result, service } from "./info-storage-fixtures.ts";

const check = {
  kind: "command",
  intervalSeconds: 1,
  timeoutSeconds: 2,
  retries: 3,
  target: "host",
  userSource: "cli",
  commandConfigured: true,
  configPath: ["services", "web", "readiness"],
} as const;

test("human info separates process status, observed health and unobserved readiness", () => {
  // Given
  const info = result(
    service("web", undefined, {
      health: { state: "healthy" },
      readiness: { state: "not-observed", source: "authored", check },
    }),
  );
  // When
  const summary = stripAnsi(renderInfoAppResult(info, decorated(120)));
  const plain = renderInfoAppResult(info);
  // Then
  expect(summary).toContain("running");
  expect(summary).toContain("healthy");
  expect(summary).toContain("configured, not observed (host, current CLI user)");
  expect(plain).toContain("web\thealth\thealthy");
  expect(plain).toContain("web\treadiness\tconfigured, not observed");
  expect(plain.split("\n")[1]).toBe("service\tstate\tHost\tApp Network");
});

test.each(["unknown", "not-monitored"] as const)("%s health stays neutral", (state) => {
  // Given / When
  const summary = buildInfoSummary(
    result(
      service("web", undefined, {
        health: { state },
        readiness: { state: "disabled", source: "authored" },
      }),
    ),
  );
  // Then
  expect(summary.sections[0]?.rows[0]?.tone).toBe("ok");
  expect(summary.sections[0]?.rows[0]?.fields).toContainEqual({ label: "readiness", value: "disabled" });
});

test("actual native unhealthy state receives the established warning tone", () => {
  // Given / When
  const summary = buildInfoSummary(result(service("web", undefined, { health: { state: "unhealthy" } })));
  // Then
  expect(summary.sections[0]?.rows[0]?.tone).toBe("warn");
});

test.each([64, 80, 120])("probe details wrap within %i columns without forged terminal rows", (columns) => {
  // Given
  const info = result(
    service("web", undefined, {
      health: { state: "starting" },
      readiness: {
        state: "not-observed",
        source: "contributed",
        check: {
          ...check,
          target: "service",
          userSource: "probe",
          user: `worker-${"x".repeat(100)}\tforged\nrow\u001b[31m`,
        },
      },
    }),
  );
  // When
  const summary = stripAnsi(renderInfoAppResult(info, decorated(columns)));
  const plain = renderInfoAppResult(info);
  // Then
  for (const line of summary.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  expect(summary).not.toContain("forged\nrow");
  expect(plain).not.toContain("forged\nrow");
  expect(plain).not.toContain("\u001b");
});
