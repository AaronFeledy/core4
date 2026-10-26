import { describe, expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const PORT = 43210;
const mechanisms: Readonly<
  Record<
    string,
    { readonly env?: string; readonly value?: string; readonly command?: string; readonly build?: string }
  >
> = {
  mysql: { env: "MYSQL_TCP_PORT" },
  mariadb: { env: "MYSQL_TCP_PORT" },
  postgres: { env: "PGPORT" },
  mssql: { env: "MSSQL_TCP_PORT" },
  rabbitmq: { env: "RABBITMQ_NODE_PORT" },
  phpmyadmin: { env: "APACHE_PORT" },
  elasticsearch: { env: "http.port" },
  opensearch: { env: "http.port" },
  node: { env: "PORT" },
  meilisearch: { env: "MEILI_HTTP_ADDR", value: `0.0.0.0:${PORT}` },
  localstack: { env: "GATEWAY_LISTEN", value: `0.0.0.0:${PORT}` },
  mailhog: { env: "MH_SMTP_BIND_ADDR", value: `0.0.0.0:${PORT}` },
  mailpit: { env: "MP_SMTP_BIND_ADDR", value: `0.0.0.0:${PORT}` },
  mongodb: { command: `--port ${PORT}` },
  redis: { command: `--port ${PORT}` },
  valkey: { command: `--port ${PORT}` },
  memcached: { command: `-p ${PORT}` },
  solr: { command: `-p ${PORT}` },
  minio: { command: `--address :${PORT}` },
  varnish: { command: `-a :${PORT}` },
  apache: { command: `Listen ${PORT}` },
  nginx: { command: `listen ${PORT};` },
  php: { command: `Listen ${PORT}` },
  static: { command: String(PORT) },
  tomcat: { build: `port=\"${PORT}\"` },
};
const exemptions: Readonly<Record<string, string>> = {
  compose: "Raw Compose has no bundled launcher.",
  lando: "The base service has no bundled daemon.",
  python: "The default command is a keep-alive, not a server.",
  ruby: "The default command is a keep-alive, not a server.",
  go: "The default command is a keep-alive, not a server.",
  dotnet: "The default command is a keep-alive, not a server.",
};
const commandText = (command: string | readonly string[] | undefined): string =>
  typeof command === "string" ? command : (command ?? []).join(" ");

describe("bundled catalog listen-port conformance", () => {
  for (const [id, serviceType] of serviceTypes) {
    test(`${id} classifies and honors an authored non-default listen port`, async () => {
      const family = id.split(":")[0] ?? id;
      const mechanism = mechanisms[family];
      if (mechanism === undefined) {
        expect(exemptions[family]).toBeDefined();
        return;
      }
      const plan = await composeServicePlan({
        serviceType:
          id === "node"
            ? {
                ...serviceType,
                resolve: (input) =>
                  serviceType.resolve({
                    ...input,
                    projectFiles: [
                      { path: ".nvmrc", present: true, text: "22", sha256: "node-port-fixture" },
                    ],
                  }),
              }
            : serviceType,
        service: Schema.decodeUnknownSync(ServiceConfig)({
          type: id,
          port: PORT,
          ...(family === "varnish" ? { backend: "web" } : {}),
        }),
        serviceName: "server",
        appName: "port-test",
        appRoot: "/srv/apps/port-test",
        metadata: { resolvedAt: "2026-10-19T00:00:00Z", source: "listen-port-conformance", runtime: 4 },
      });
      expect(plan.endpoints).toContainEqual(expect.objectContaining({ port: PORT }));
      if (mechanism.env !== undefined)
        expect(plan.environment[mechanism.env]).toBe(mechanism.value ?? String(PORT));
      if (mechanism.command !== undefined) expect(commandText(plan.command)).toContain(mechanism.command);
      if (mechanism.build !== undefined) {
        const features = Schema.decodeUnknownSync(
          Schema.Struct({
            buildSteps: Schema.Array(Schema.Struct({ id: Schema.String, command: Schema.Unknown })),
          }),
        )(plan.extensions["@lando/core/service-features"]);
        const step = features.buildSteps.find((step) => step.id === "service-lando.tomcat:server-config");
        expect(commandText(Schema.decodeUnknownSync(Schema.Array(Schema.String))(step?.command))).toContain(
          mechanism.build,
        );
      }
    });
  }
});
