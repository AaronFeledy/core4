import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { commonContainerLabels, containerCreateBodyFragment } from "../src/plan.ts";
import { renderCompose } from "../src/podman/compose.ts";
import { compileServiceProbe } from "../src/service-probe.ts";
import { runServiceStartSchedule } from "../src/service-start-schedule.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  source: "probe",
  runtime: 4 as const,
};
const cheap = {
  kind: "command" as const,
  command: ["bash", "-c", "exit 0"],
  intervalSeconds: 0,
  timeoutSeconds: 1,
  retries: 1,
};
const target = { port: 27017, transport: "tcp" as const, names: [], primary: false };
const service: ServicePlan = {
  name: ServiceName.make("db"),
  type: "mongodb",
  provider: ProviderId.make("test"),
  primary: false,
  artifact: { kind: "ref", ref: "mongo:7" },
  environment: {},
  mounts: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  endpoints: [{ _tag: "internal", protocol: "tcp", port: 27017, primary: true, name: "mongo" }],
  metadata,
  healthcheck: { ...cheap, target },
  readiness: { ...cheap, command: ["strong"], target },
};
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("probe"),
  name: "probe",
  slug: "demo",
  root: AbsolutePath.make("/tmp/probe"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("executes targeted argv with declared host and port while preserving literal arguments", async () => {
  const probe = {
    ...cheap,
    target,
    command: [
      "bash",
      "-c",
      'printf "%s\\n" "$LANDO_PROBE_HOST" "$LANDO_PROBE_PORT" "$1"',
      "probe",
      "literal argument",
    ],
  };
  const command = compileServiceProbe(probe, plan, service);
  if (command === undefined) throw new Error("Expected compiled command");
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("db\n27017\nliteral argument\n");
});

test("preserves untargeted custom commands without injecting a target", async () => {
  const command = compileServiceProbe({ ...cheap, command: 'printf "%s" custom' });
  if (command === undefined) throw new Error("Expected compiled command");
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("custom");
});

test.each([0, 1])("gates dependents on strong readiness with exit=%s, not cheap health", async (exitCode) => {
  const db = { ...service, readiness: { ...cheap, command: ["strong", String(exitCode)], target } };
  const api: ServicePlan = {
    ...service,
    name: ServiceName.make("api"),
    dependsOn: [{ service: db.name, condition: "service_healthy", required: true }],
  };
  const started: string[] = [];
  const observed: string[][] = [];
  const result = await Effect.runPromise(
    runServiceStartSchedule(
      { ...plan, services: { [db.name]: db, [api.name]: api } },
      {
        startService: (value) =>
          Effect.sync(() => {
            started.push(value.name);
            return { changed: true };
          }),
        execHealthcheck: (_value, command) =>
          Effect.sync(() => {
            observed.push([...command]);
            return { exitCode };
          }),
        waitForExit: () => Effect.succeed({ exitCode: 0 }),
      },
    ),
  );
  expect(started.includes("api")).toBe(exitCode === 0);
  expect(observed).toEqual([
    ["env", "LANDO_PROBE_HOST=db", "LANDO_PROBE_PORT=27017", "strong", String(exitCode)],
  ]);
  expect(result._tag).toBe("Settled");
});

test("keeps native and Compose health cheap with the same compiler target", () => {
  const native = containerCreateBodyFragment(plan, service);
  expect(native.Healthcheck).toMatchObject({
    Test: ["CMD", "env", "LANDO_PROBE_HOST=db", "LANDO_PROBE_PORT=27017", "bash", "-c", "exit 0"],
  });
  const compose = renderCompose(plan, { providerId: "test", remediation: "retry", env: {} });
  expect(compose).toContain('"LANDO_PROBE_HOST=db"');
  expect(compose).toContain('"LANDO_PROBE_PORT=27017"');
  expect(compose).not.toContain('"strong"');
});

test("fingerprints startup command and canonical shared target changes without environment changes", () => {
  const fingerprint = (app: AppPlan, value: ServicePlan) =>
    commonContainerLabels(app, value)["dev.lando.create-config"];
  expect(fingerprint(plan, service)).not.toBe(
    fingerprint(plan, { ...service, readiness: { ...cheap, target, command: ["changed"] } }),
  );
  const shared = {
    ...plan,
    networking: { perAppBridge: null, sharedNetworkMembership: { name: "shared", aliases: {} } },
  };
  expect(fingerprint(shared, service)).not.toBe(fingerprint({ ...shared, slug: "other" }, service));
});

test("fingerprints logical listener identity but not descriptive target aliases", () => {
  const value = {
    ...service,
    endpoints: [...service.endpoints, { _tag: "internal" as const, protocol: "tcp" as const, port: 27018 }],
  };
  const fingerprint = (targetPort: number, names: readonly string[], primary: boolean) =>
    commonContainerLabels(plan, {
      ...value,
      readiness: { ...cheap, command: ["ready"], target: { ...target, port: targetPort, names, primary } },
    })["dev.lando.create-config"];
  expect(fingerprint(27017, [], false)).not.toBe(fingerprint(27018, [], false));
  expect(fingerprint(27017, [], false)).toBe(fingerprint(27017, ["renamed"], true));
});
