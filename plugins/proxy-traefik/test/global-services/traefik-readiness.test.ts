import { expect, test } from "bun:test";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ServiceName, effectiveReadiness } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import diagnostics from "../../src/global-services/diagnostics.ts";
import { buildTraefikServiceConfig } from "../../src/global-services/traefik.ts";

test("the bundled Traefik plan gates startup on ping with subsecond retries", async () => {
  const config = buildTraefikServiceConfig({ http: 38080, https: 38443 });
  const diagnosticConfig = await Effect.runPromise(diagnostics);
  const root = process.cwd();
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: `${root}/.lando.yml`,
          value: {
            name: "traefik-readiness",
            services: { traefik: config, "traefik-diagnostics": diagnosticConfig },
          },
        },
      ],
      { appRoot: root, file: `${root}/.lando.yml` },
    ),
  );

  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(compiled, TestRuntimeProvider.capabilities)).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(PluginRegistryLayer.layer),
    ),
  );

  const traefik = plan.services[ServiceName.make("traefik")];
  expect(traefik).toBeDefined();
  if (traefik === undefined) throw new Error("Missing planned Traefik service");
  expect(effectiveReadiness(traefik)).toMatchObject({
    kind: "command",
    command: ["traefik", "healthcheck", "--ping"],
    intervalSeconds: 0.25,
    timeoutSeconds: 1,
    retries: 120,
  });
  const command = typeof traefik.command === "string" ? traefik.command : traefik.command?.join(" ");
  expect(command).toContain("--ping=true");
  expect(command).toContain("--ping.entrypoint=traefik");
  expect(command).toContain("--entrypoints.traefik.address=:8080");
});
