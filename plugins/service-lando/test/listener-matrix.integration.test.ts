import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { listenerContracts } from "../src/service-type-facts.ts";
import { acquireListenerApp } from "./support/listener-cli.ts";
import {
  listenerDiagnosticJourneys,
  runListenerDiagnosticJourney,
} from "./support/listener-diagnostic-journeys.ts";
import { matrixFixtures } from "./support/listener-matrix-fixtures.ts";
import { observeMatrixListener } from "./support/listener-matrix-observation.ts";

const strict = process.env.LANDO_TEST_LISTENER_MATRIX_STRICT === "1";
// Dozens of serial live boots outlast the PR services job; only the nightly (strict) or an explicit opt-in runs them.
const enabled = strict || process.env.LANDO_TEST_LISTENER_MATRIX === "1";
const socket = resolveLiveProviderSocket();
const contracts = listenerContracts();
const filter = process.env.LANDO_TEST_LISTENER_MATRIX_FAMILIES?.split(",").map((item) => item.trim());
const minioImage = process.env.LANDO_TEST_MINIO_IMAGE?.trim();
const completed: string[] = [];
const selected = matrixFixtures.filter((item) => {
  const family = item.contract.split("/")[0] ?? item.contract;
  return (
    (filter === undefined || filter.includes(family)) &&
    (family !== "minio" || Boolean(minioImage)) &&
    (family !== "mssql" || process.env.LANDO_TEST_LISTENER_MATRIX_MSSQL === "1")
  );
});
const cases = selected.flatMap((fixture) =>
  [false, true].map((moved) => ({
    fixture,
    moved,
    id: `${fixture.contract}-${moved ? "moved" : "default"}`,
  })),
);
const diagnostics = listenerDiagnosticJourneys.filter(
  (item) => filter === undefined || filter.includes(item.family),
);
const expectedIds = [...cases.map((item) => item.id), ...diagnostics.map((item) => item.id)];
const missing = [
  ...(socket === undefined ? ["LANDO_TEST_PODMAN_SOCKET must name an answering explicit socket"] : []),
  ...(!process.env.LANDO_SCENARIO_E2E_BINARY?.trim()
    ? ["LANDO_SCENARIO_E2E_BINARY must name the current compiled CLI"]
    : []),
];

describe.serial("bundled service listener matrix", () => {
  beforeAll(() => {
    if (selected.length === 0) throw new Error("Listener matrix family filter selected no enabled cases");
    const families = new Set(matrixFixtures.map((item) => item.contract.split("/")[0]));
    const unknown = filter?.filter((family) => !families.has(family)) ?? [];
    if (unknown.length > 0) throw new Error(`Unknown listener matrix families: ${unknown.join(",")}`);
    const uncovered = Object.keys(contracts).filter(
      (key) => !matrixFixtures.some((item) => item.contract === key),
    );
    expect(uncovered, "Every bundled listener contract needs a reviewed fixture").toEqual([]);
    if (enabled && missing.length > 0) {
      const message = `Listener matrix prerequisites:\n${missing.join("\n")}`;
      if (strict) throw new Error(message);
      console.warn(message);
    }
  });
  afterAll(() => {
    if (!enabled) return;
    console.log(
      `SERVICE_LISTENER_MATRIX completed=${completed.length}/${expectedIds.length} cases=${completed.join(",")}`,
    );
    if (
      strict &&
      (completed.length !== expectedIds.length || expectedIds.some((id) => !completed.includes(id)))
    )
      throw new Error(`Listener matrix incomplete: completed=${completed.length}/${expectedIds.length}`);
  });
  for (const item of cases) {
    test.skipIf(!enabled || (!strict && missing.length > 0))(
      item.id,
      async () => {
        if (socket === undefined) throw new Error(missing.join("\n"));
        const contract = contracts[item.fixture.contract];
        if (contract === undefined) throw new Error(`Missing listener contract ${item.fixture.contract}`);
        const family = item.fixture.contract.split("/")[0] ?? item.fixture.contract;
        const port = item.moved ? 18080 : contract.port;
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              // Given: a unique app and the catalog image's normal startup, unless application-owned.
              const app = yield* acquireListenerApp(socket.socketPath);
              for (const [name, source] of Object.entries(item.fixture.files ?? {}))
                yield* Effect.promise(() => Bun.write(join(app.root, name), source));
              const services = {
                subject: {
                  appMount: false,
                  home: false,
                  certs: false,
                  ...item.fixture.service,
                  ...(item.moved ? { port } : {}),
                  ...(family === "minio" && minioImage ? { image: minioImage } : {}),
                },
                // Approved sole two-service exception: the bundled Varnish launcher requires a backend.
                ...(family === "varnish"
                  ? { backend: { type: "nginx", appMount: "/app", home: false, certs: false } }
                  : {}),
              } satisfies NonNullable<typeof LandofileShape.Encoded.services>;
              // When: the compiled CLI plans and starts the service on its default or moved port.
              const started = yield* app.start({ services });
              const subject = started.servicesStarted.find((service) => service.name === "subject");
              expect(
                subject?.connections.some(
                  (connection) => connection.source === "listener" && connection.port === port,
                ),
              ).toBe(true);
              // Then: the actual subject-container sockets match the planned listener and only allowed secondaries.
              yield* observeMatrixListener(app, { contract, family, port });
            }).pipe(Effect.timeout("10 minutes")),
          ),
        );
        completed.push(item.id);
      },
      720_000,
    );
  }
  for (const journey of diagnostics) {
    test.skipIf(!enabled || (!strict && missing.length > 0))(
      journey.id,
      async () => {
        if (socket === undefined) throw new Error(missing.join("\n"));
        await Effect.runPromise(
          Effect.scoped(
            runListenerDiagnosticJourney(socket.socketPath, journey).pipe(Effect.timeout("10 minutes")),
          ),
        );
        completed.push(journey.id);
      },
      720_000,
    );
  }
});
