import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

import {
  AbsolutePath,
  LogSourceId,
  PortablePath,
  ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { planMysqlApp as planApp } from "./support/mysql-planner.ts";

const web = ServiceName.make("web");
const stock = ServiceName.make("stock");
const buildSteps = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      buildSteps: Schema.Array(Schema.Struct({ id: Schema.String, command: Schema.Unknown })),
    }),
  )(plan.extensions["@lando/core/service-features"]).buildSteps;
const phpConfig = (input: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", home: false, ...input });
const requireWeb = (services: Readonly<Record<string, ServicePlan>>): ServicePlan => {
  const service = services[web];
  if (service === undefined) throw new Error("planned PHP service missing");
  return service;
};

describe("PHP ownership through AppPlanner", () => {
  test.each(["apache", "fpm", "cli"])("preserves the authored build artifact for %s", async (via) => {
    // Given: version resolution stamps a catalog image onto this replacement build.
    const service = phpConfig({
      via,
      build: { context: ".", dockerfile: "Dockerfile.php", target: "development", args: { MODE: "dev" } },
      framework: "wordpress",
      xdebug: true,
    });
    // When: run the complete planner, including artifact finalization and AppFeatures.
    const plan = requireWeb((await planApp({ [web]: service })).services);
    // Then: the replacement artifact survives; PHP contributes no installers or launcher.
    expect(plan.artifact).toEqual({
      kind: "build",
      context: AbsolutePath.make(resolve(".")),
      spec: PortablePath.make("Dockerfile.php"),
      target: "development",
      args: { MODE: "dev" },
    });
    expect(buildSteps(plan).filter(({ id }) => id.startsWith("service-lando.php:"))).toEqual([]);
    expect(plan.command).toBeUndefined();
    expect(plan.entrypoint).toBeUndefined();
    expect(plan.environment.WP_CLI_ALLOW_ROOT).toBeUndefined();
  });

  for (const via of ["apache", "fpm", "cli"]) {
    test.each([{ image: "example/php:custom" }, { build: { context: "." } }])(
      `omits implicit log redirects for author-owned ${via} %j`,
      async (ownership) => {
        // Given / When: a custom runtime goes through the generic log-source stage too.
        const plan = requireWeb((await planApp({ [web]: phpConfig({ via, ...ownership }) })).services);
        // Then: console output needs no file sources; no author-owned path is overwritten.
        expect(plan.logSources ?? []).toEqual([]);
        expect(buildSteps(plan).filter(({ id }) => id.startsWith("lando-log-redirect"))).toEqual([]);
      },
    );
  }

  test.each(["apache", "fpm"])("keeps stock %s log defaults", async (via) => {
    // Given / When: stock PHP owns its generated process.
    const plan = requireWeb((await planApp({ [web]: phpConfig({ via }) })).services);
    // Then: aliases select native streams without filesystem redirect steps.
    expect(plan.logSources?.map(({ id, stream }) => ({ id, stream }))).toEqual([
      { id: LogSourceId.make("access"), stream: via === "fpm" ? "stderr" : "stdout" },
      { id: LogSourceId.make("error"), stream: "stderr" },
    ]);
    expect(plan.logSources?.every((source) => source.strategy === "console")).toBe(true);
    expect(buildSteps(plan).filter(({ id }) => id.startsWith("lando-log-redirect:"))).toHaveLength(0);
  });

  test.each([{}, { image: "example/php:custom" }, { build: { context: "." } }])(
    "preserves explicitly authored log sources for %j",
    async (ownership) => {
      // Given: an explicit access source replaces the stock path, if any.
      const service = phpConfig({
        ...ownership,
        logs: [
          { id: "access", path: "/custom/access.log", stream: "stdout" },
          { id: "audit", path: "/custom/audit.log", stream: "stderr" },
        ],
      });
      // When
      const plan = requireWeb((await planApp({ [web]: service })).services);
      // Then: generic logging still honors author opt-in, without redirecting followed files.
      expect(plan.logSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "access",
            path: "/custom/access.log",
            stream: "stdout",
            strategy: "follow",
          }),
          expect.objectContaining({
            id: "audit",
            path: "/custom/audit.log",
            stream: "stderr",
            strategy: "follow",
          }),
        ]),
      );
      expect(
        buildSteps(plan).filter(({ id }) => /^lando-log-redirect(?:-mkdir)?:(access|audit)$/u.test(id)),
      ).toEqual([]);
    },
  );

  test.each(["auto", "postgres:16"])(
    "skips contextual database-client %s through the real AppFeature",
    async (db_client) => {
      // Given: a stock control proves the AppFeature actually runs for this selection.
      const services = {
        [web]: phpConfig({ build: { context: "." }, db_client }),
        [stock]: phpConfig({ db_client }),
        [ServiceName.make("db")]: { type: "postgres:16" },
      };
      // When
      const plan = await planApp(services);
      // Then: only the stock service gets the selected client installer.
      const stockPlan = plan.services[stock];
      if (stockPlan === undefined) throw new Error("stock PHP control missing");
      expect(buildSteps(stockPlan).map(({ id }) => id)).toContain("service-lando.php:db-client:postgres");
      expect(
        buildSteps(requireWeb(plan.services)).filter(({ id }) =>
          id.startsWith("service-lando.php:db-client:"),
        ),
      ).toEqual([]);
    },
  );

  test("keeps stock setup and authored scripts when build steps are additive", async () => {
    // Given
    const service = phpConfig({ build: { artifact: ["echo artifact"], app: ["echo app"] } });
    // When
    const plan = requireWeb((await planApp({ [web]: service })).services);
    // Then
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.3-apache-bookworm" });
    expect(buildSteps(plan).map(({ id }) => id)).toEqual(
      expect.arrayContaining(["service-lando.php:prerequisites", "authored-artifact:1", "authored-app:1"]),
    );
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
  });
});
