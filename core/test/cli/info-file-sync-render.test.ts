import { expect, test } from "bun:test";
import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import type { FileSyncInfo, FileSyncPolicyInfo } from "@lando/sdk/schema";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, result, service } from "./info-storage-fixtures.ts";

const ordinary: FileSyncPolicyInfo = {
  mode: "ordinary",
  reason: "native-provider",
  services: [
    {
      service: "web",
      mode: "ordinary",
      reason: "native-provider",
      exclusions: { kind: "directory-overlays", patterns: [], overlays: ["/app/node_modules"] },
      hostBackedIncludes: [{ source: "/private/project/vendor", target: "/app/vendor" }],
    },
  ],
};
const accelerated: FileSyncPolicyInfo = {
  ...ordinary,
  mode: "accelerated",
  engineId: "mutagen",
  reason: "default-engine",
  services: ordinary.services.map((entry) => ({
    ...entry,
    mode: "accelerated",
    reason: "default-engine",
    exclusions: { ...entry.exclusions, kind: "transport-patterns", patterns: ["node_modules", ".git"] },
  })),
};
const info = (fileSync: FileSyncInfo) => ({ ...result(service("web", undefined)), fileSync });

test("shows planned direct mounts and their exclusion mechanism without leaking host sources", () => {
  const input = info({ planned: ordinary, pendingChange: false });
  const section = buildInfoSummary(input).sections.find(({ title }) => title === "project files");
  expect(section?.rows[0]).toMatchObject({ label: "planned", value: "Direct mounts" });
  for (const text of [renderInfoAppResult(input), stripAnsi(renderInfoAppResult(input, decorated(100)))]) {
    expect(text).toContain("Directory overlays");
    expect(text).toContain("/app/vendor");
    expect(text).not.toContain("/private/project");
    expect(text).not.toContain("mutagen");
  }
});

test("distinguishes the applied accelerated plan from a pending ordinary plan", () => {
  const input = info({ applied: accelerated, planned: ordinary, pendingChange: true });
  const section = buildInfoSummary(input).sections.find(({ title }) => title === "project files");
  expect(section?.rows.map(({ label }) => label)).toEqual(["applied", "next start"]);
  const text = stripAnsi(renderInfoAppResult(input, decorated(100)));
  expect(text.match(/mutagen/g)).toHaveLength(1);
  expect(text).toContain("Transport filters");
  expect(text).toContain("lando start");
});

test("keeps unknown applied evidence distinct without claiming a pending change", () => {
  const input = info({
    applied: { ...ordinary, mode: "unknown", reason: "unknown" },
    planned: ordinary,
    pendingChange: false,
  });
  const section = buildInfoSummary(input).sections.find(({ title }) => title === "project files");
  expect(section?.rows.map(({ label }) => label)).toEqual(["applied", "planned"]);
  expect(section?.rows[0]?.value).toBe("Unknown");
  expect(section?.notes ?? []).not.toContain("Run `lando start` to apply the planned change safely.");
});

test("omits the section for embedding results without policy", () => {
  expect(buildInfoSummary(result()).sections.some(({ title }) => title === "project files")).toBe(false);
});

test("explains unavailable desired policy while retaining the applied summary", () => {
  const input = info({ applied: ordinary, pendingChange: false });
  const section = buildInfoSummary(input).sections.find(({ title }) => title === "project files");
  expect(section?.rows.map(({ label }) => label)).toEqual(["applied"]);
  expect(renderInfoAppResult(input)).toContain("Desired policy unavailable");
  expect(renderInfoAppResult(input)).toContain("lando app:cache:refresh");
  expect(renderInfoAppResult(input)).not.toContain("next start");
});

test.each([60, 100])("wraps policy details at %i columns and escapes controls", (columns) => {
  const input = info({
    planned: {
      ...accelerated,
      engineId: "sync\u001b[31m\tbad",
      services: accelerated.services.map((entry) => ({
        ...entry,
        service: "web\nforged",
        hostBackedIncludes: [
          { source: "/private", target: "/app/vendor/very-long-package-name-with-many-segments" },
        ],
      })),
    },
    pendingChange: false,
  });
  const text = stripAnsi(renderInfoAppResult(input, decorated(columns)));
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("web\nforged");
  expect(text.split("\n").every((line) => displayWidth(line) <= columns)).toBe(true);
});
