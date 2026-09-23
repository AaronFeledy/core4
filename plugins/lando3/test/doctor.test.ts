import { describe, expect, test } from "bun:test";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import {
  type DoctorExecutableLocation,
  type DoctorResourceInspection,
  type DoctorResourceNameQuery,
  PluginDoctorReport,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import packageJson from "../package.json";
import { runLando3Leftovers, runLando3Shadow } from "../src/doctor.ts";
import { plugin } from "../src/index.ts";
import { lando3ProjectName } from "../src/naming.ts";

const base: PluginDoctorCheckInput = {
  providerId: "docker",
  platform: "linux",
  env: {},
  userDataRoot: undefined,
  binDir: undefined,
  stateDir: undefined,
  app: { name: "My_App.Site", root: "/apps/site" },
};
const empty: DoctorResourceInspection = { status: "ok", names: [], truncated: false };
const inspector = (volume: DoctorResourceInspection = empty, container: DoctorResourceInspection = empty) => {
  const calls: DoctorResourceNameQuery[] = [];
  return {
    calls,
    inspect: (query: DoctorResourceNameQuery) =>
      Effect.sync(() => {
        calls.push(query);
        return query.kind === "volume" ? volume : container;
      }),
  };
};
const locator = (location: DoctorExecutableLocation) => {
  const calls: string[] = [];
  return {
    calls,
    locate: (name: string) =>
      Effect.sync(() => {
        calls.push(name);
        return location;
      }),
  };
};
const report = async (effect: Effect.Effect<ReadonlyArray<PluginDoctorReport>>, name: string) => {
  const reports = await Effect.runPromise(effect);
  expect(reports).toHaveLength(1);
  const decoded = Schema.decodeUnknownSync(PluginDoctorReport, { onExcessProperty: "error" })(reports[0]);
  expect(decoded.name).toBe(name);
  return decoded;
};

describe("lando3 leftovers", () => {
  test.each(["docker", "podman"])("warns with exact bounded queries when %s has hits", async (providerId) => {
    // Given
    const resources = inspector(
      { status: "ok", names: ["myappsite_data"], truncated: false },
      { status: "ok", names: ["legacy_web"], truncated: false },
    );
    // When
    const result = await report(runLando3Leftovers({ ...base, providerId, resources }), "lando3-leftovers");
    // Then
    expect(resources.calls).toEqual([
      { kind: "volume", namePrefix: "myappsite_", limit: 32 },
      { kind: "container", label: { key: "io.lando.root", value: "/apps/site" }, limit: 32 },
    ]);
    expect(result).toMatchObject({
      status: "warn",
      severity: "warn",
      runtimeStatus: "lando3-resources-found",
      context: { project: "myappsite", providerId, volumes: "myappsite_data", containers: "legacy_web" },
    });
    expect(result.solutions).toHaveLength(1);
    expect(result.solutions[0]?.kind).toBe("manual");
  });
  test.each([
    { overrides: { app: undefined, providerId: "lando" }, reason: "no-app-context" },
    { overrides: { providerId: "lando" }, reason: "managed-provider" },
    { overrides: { providerId: "custom" }, reason: "unsupported-provider" },
    { overrides: { app: { name: "...", root: "/apps/site" } }, reason: "no-project-name" },
  ])("skips without inspecting when $reason", async ({ overrides, reason }) => {
    // Given
    const resources = inspector();
    // When
    const result = await report(runLando3Leftovers({ ...base, ...overrides, resources }), "lando3-leftovers");
    // Then
    expect(resources.calls).toEqual([]);
    expect(result).toMatchObject({
      status: "pass",
      severity: "info",
      runtimeStatus: "skipped",
      context: { reason },
    });
    if (reason === "no-app-context") expect(result.solutions[0]?.command).toBe("lando4 doctor");
  });
  test("skips when no inspector exists", async () => {
    // Given / When
    const result = await report(runLando3Leftovers(base), "lando3-leftovers");
    // Then
    expect(result.context.reason).toBe("no-inspector");
    expect(result.runtimeStatus).toBe("skipped");
  });
  test.each(["unsupported", "unavailable"] as const)(
    "is unverified when either query is %s",
    async (status) => {
      // Given
      const resources = inspector(empty, { status, reason: "provider unreachable [REDACTED]" });
      // When
      const result = await report(runLando3Leftovers({ ...base, resources }), "lando3-leftovers");
      // Then
      expect(result).toMatchObject({
        status: "pass",
        severity: "info",
        runtimeStatus: "unverified",
        context: { reason: "provider unreachable [REDACTED]" },
      });
      expect(result.solutions[0]?.kind).toBe("manual");
    },
  );
  test("passes when both inspections are empty", async () => {
    // Given
    const resources = inspector();
    // When
    const result = await report(runLando3Leftovers({ ...base, resources }), "lando3-leftovers");
    // Then
    expect(result).toMatchObject({ status: "pass", severity: "info", runtimeStatus: "none-found" });
  });
  test("preserves hits when the other inspection is unavailable", async () => {
    // Given
    const resources = inspector(
      { status: "unavailable", reason: "offline" },
      { status: "ok", names: ["web"], truncated: false },
    );
    // When
    const result = await report(runLando3Leftovers({ ...base, resources }), "lando3-leftovers");
    // Then
    expect(result.runtimeStatus).toBe("lando3-resources-found");
    expect(result.context.containers).toBe("web");
  });
  test("caps names and exposes truncation when results are large", async () => {
    // Given
    const hits: DoctorResourceInspection = {
      status: "ok",
      names: Array.from({ length: 32 }, () => "a".repeat(256)),
      truncated: true,
    };
    const resources = inspector(hits, hits);
    // When
    const result = await report(runLando3Leftovers({ ...base, resources }), "lando3-leftovers");
    // Then
    expect(result.context.volumes?.length).toBe(2000);
    expect(result.context.containers?.length).toBe(2000);
    expect(result.context).toMatchObject({ volumesTruncated: "true", containersTruncated: "true" });
  });
  test.each([
    ["My_App.Site", "myappsite"],
    ["Lando-Sluggy", "landosluggy"],
    ["café", "cafe"],
  ])("uses Lando 3 project naming for %s", (name, expected) => {
    // Given / When / Then
    expect(lando3ProjectName(name)).toBe(expected);
  });
});

describe("lando3 shadow", () => {
  test("skips when no locator exists", async () => {
    // Given / When
    const result = await report(runLando3Shadow(base), "lando3-shadow");
    // Then
    expect(result).toMatchObject({
      status: "pass",
      severity: "info",
      runtimeStatus: "skipped",
      context: { reason: "no-locator" },
    });
  });
  const cases: ReadonlyArray<{
    readonly location: DoctorExecutableLocation;
    readonly runtimeStatus: string;
    readonly context: Readonly<Record<string, string>>;
  }> = [
    {
      location: { runningBasename: "bun", candidate: { kind: "found", path: "/bin/lando" } },
      runtimeStatus: "skipped",
      context: { reason: "not-running-as-lando4" },
    },
    {
      location: { runningBasename: "lando4", candidate: { kind: "missing" } },
      runtimeStatus: "no-lando-on-path",
      context: {},
    },
    {
      location: { runningBasename: "lando4", candidate: { kind: "ambiguous", reason: "PATH unavailable" } },
      runtimeStatus: "unverified",
      context: { reason: "PATH unavailable" },
    },
    {
      location: {
        runningBasename: "lando4",
        runningPath: "/bin/lando4",
        candidate: { kind: "found", path: "/bin/lando4" },
      },
      runtimeStatus: "same-executable",
      context: {},
    },
    {
      location: {
        runningBasename: "lando4",
        runningPath: "/bin/lando4",
        candidate: { kind: "found", path: "/bin/lando" },
      },
      runtimeStatus: "potential-shadow",
      context: { candidate: "/bin/lando", runningPath: "/bin/lando4" },
    },
    {
      location: { runningBasename: "lando4", candidate: { kind: "found", path: "/bin/lando" } },
      runtimeStatus: "unverified",
      context: {
        candidate: "/bin/lando",
        reason: "The running executable path could not be resolved, so this candidate was not compared.",
      },
    },
  ];
  test.each([...cases])(
    "reports $runtimeStatus informationally",
    async ({ location, runtimeStatus, context }) => {
      // Given
      const executables = locator(location);
      // When
      const result = await report(runLando3Shadow({ ...base, executables }), "lando3-shadow");
      // Then
      expect(executables.calls).toEqual(["lando"]);
      expect(result).toMatchObject({ status: "pass", severity: "info", runtimeStatus, context });
      if (runtimeStatus === "potential-shadow") expect(result.solutions[0]?.kind).toBe("manual");
    },
  );
});

test("contributes only the two lazy SDK-only doctor checks", async () => {
  // Given
  const checks = plugin.doctorChecks ?? [];
  // When
  const results = await Promise.all(checks.map((check) => report(check.run(base), check.id)));
  // Then
  expect(checks.map((check) => check.id)).toEqual(["lando3-leftovers", "lando3-shadow"]);
  expect(checks.every((check) => check.relevant === undefined)).toBe(true);
  expect(results).toHaveLength(2);
  expect(
    Object.keys(packageJson.dependencies).every((name) =>
      ["@lando/sdk", "@lando/paths", "effect"].includes(name),
    ),
  ).toBe(true);
  const sourceRoot = new URL("../src/", import.meta.url).pathname;
  for await (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs}").scan({ cwd: sourceRoot, absolute: true })) {
    const source = await Bun.file(file).text();
    expect(source).not.toMatch(
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@lando\/(?:core|container-runtime)(?:[/'"])/,
    );
  }
});
