import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  DEPENDENCY_ENVIRONMENT_EXTENSION_KEY,
  type EngineIdentity,
  PortablePath,
  ProviderId,
  ServiceName,
  ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import {
  RECREATED_DATA_VOLUME_CODE,
  type RecreatedVolumeBaseline,
  recreatedVolumeWarnings,
} from "../../src/lifecycle/recreated-volumes.ts";

const root = AbsolutePath.make("/tmp/recreated-volumes");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-28T00:00:00Z"),
  source: "recreated-volumes.test",
  runtime: 4 as const,
};
const provider = ProviderId.make("podman");
const engine = (host: string): EngineIdentity => ({
  fingerprint: host,
  endpoint: `unix:///${host}/podman.sock`,
});

const database = (mounts: ServicePlan["mounts"] = [], connection = true) => {
  const service = ServicePlan.make({
    name: ServiceName.make("db"),
    type: "mariadb",
    provider,
    primary: false,
    artifact: { kind: "ref", ref: "mariadb:11.4" },
    environment: {},
    mounts,
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
    ...(connection
      ? {
          connection: {
            family: "mariadb" as const,
            port: 3306,
            creds: { user: "user", password: "password", database: "db" },
          },
        }
      : {}),
  });
  return service;
};

const volumeMount = (store: string, target: string) => ({
  type: "volume" as const,
  store,
  target: PortablePath.make(target),
  origin: "service" as const,
  readOnly: false,
});

const baselineAt = (
  services: Readonly<Record<string, ServicePlan>>,
  stores: RecreatedVolumeBaseline["stores"],
  identity?: EngineIdentity,
): RecreatedVolumeBaseline => ({
  valueModel: 1,
  id: AppId.make("recreated"),
  name: "recreated",
  slug: "recreated",
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
  provider,
  services,
  routes: [],
  stores,
  fileSync: [],
  metadata,
  extensions: {},
  ...(identity === undefined ? {} : { engineIdentity: identity }),
});

const created = (volume: string) => ({
  nativeName: volume,
  generation: "generation-two",
  ownerRoot: root,
});

test("a recreated data volume warns with the record, target, and database next step", () => {
  const db = database([volumeMount("db-data", "/var/lib/mysql")]);
  const baseline = baselineAt({ db }, [{ name: "db-data", scope: "app", kind: "data" }], engine("first"));

  const warnings = recreatedVolumeWarnings({
    facts: [created("db-data")],
    baseline,
    engine: engine("first"),
  });

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    code: RECREATED_DATA_VOLUME_CODE,
    context: {
      app: "recreated",
      service: "db",
      volume: "db-data",
      target: "/var/lib/mysql",
      engineReplaced: "false",
    },
  });
  expect(warnings[0]?.message).toContain("db-data was recreated without its previous contents");
  expect(warnings[0]?.message).not.toContain("empty");
  expect(warnings[0]?.remediation).toContain("lando db:snapshots");
  expect(warnings[0]?.remediation).toContain("lando db:restore <snapshot> --service db");
});

test("a recreated volume on a replaced engine names the recorded engine", () => {
  const db = database([volumeMount("db-data", "/var/lib/mysql")]);
  const baseline = baselineAt({ db }, [{ name: "db-data", scope: "app", kind: "data" }], engine("first"));

  const warnings = recreatedVolumeWarnings({
    facts: [created("db-data")],
    baseline,
    engine: engine("second"),
  });

  expect(warnings[0]?.context).toMatchObject({
    engineReplaced: "true",
    recordedEngine: "unix:///first/podman.sock",
  });
  expect(warnings[0]?.message).toContain("unix:///first/podman.sock");
});

test("a service without a database connection offers a re-import instead of a snapshot", () => {
  const web = database([volumeMount("web-data", "/var/www")], false);
  const baseline = baselineAt({ web }, [{ name: "web-data", scope: "app", kind: "data" }]);

  const warnings = recreatedVolumeWarnings({ facts: [created("web-data")], baseline });

  expect(warnings[0]?.remediation).toContain("Re-import");
  expect(warnings[0]?.remediation).not.toContain("snapshot");
});

test.each([
  ["a cache store", [{ name: "db-cache", scope: "app", kind: "cache" as const }], "db-cache"],
  ["an unmounted data store", [{ name: "loose-data", scope: "app", kind: "data" as const }], "loose-data"],
] as const)("%s never warns", (_label, stores, volume) => {
  const db = database([volumeMount("db-data", "/var/lib/mysql")]);

  const warnings = recreatedVolumeWarnings({
    facts: [created(volume)],
    baseline: baselineAt({ db }, stores),
  });

  expect(warnings).toEqual([]);
});

test("a creation fact for another app root is not this record's volume", () => {
  const db = database([volumeMount("db-data", "/var/lib/mysql")]);
  const baseline = baselineAt({ db }, [{ name: "db-data", scope: "app", kind: "data" }]);

  const warnings = recreatedVolumeWarnings({
    facts: [{ ...created("db-data"), ownerRoot: AbsolutePath.make("/tmp/other") }],
    baseline,
  });

  expect(warnings).toEqual([]);
});

test("a dependency environment store never claims the user's data, including the job's own mount", () => {
  const store = "dep-store";
  const mount = volumeMount(store, "/deps");
  const jobExtension = {
    kind: "node",
    consumers: ["web"],
    inputs: "package.json",
  };
  const job = ServicePlan.make({
    name: ServiceName.make("deps"),
    type: "compose",
    provider,
    primary: false,
    artifact: { kind: "ref", ref: "node:22" },
    environment: {},
    mounts: [mount],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { [DEPENDENCY_ENVIRONMENT_EXTENSION_KEY]: jobExtension },
  });
  const consumer = ServicePlan.make({
    name: ServiceName.make("web"),
    type: "compose",
    provider,
    primary: false,
    artifact: { kind: "ref", ref: "node:22" },
    environment: {},
    mounts: [mount],
    endpoints: [],
    routes: [],
    dependsOn: [
      { service: ServiceName.make("deps"), condition: "service_completed_successfully", required: true },
    ],
    hostAliases: [],
    metadata,
    extensions: {},
  });
  const baseline = baselineAt({ deps: job, web: consumer }, [{ name: store, scope: "app", kind: "data" }]);

  expect(recreatedVolumeWarnings({ facts: [created(store)], baseline })).toEqual([]);
});
