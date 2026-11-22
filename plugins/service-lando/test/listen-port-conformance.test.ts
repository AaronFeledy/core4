import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceTypes } from "../src/index.ts";
import { listenerContracts } from "../src/service-type-facts.ts";
import { LANDO_ERROR_PAGES_BUILD_STEP_ID } from "../src/services/http-errors.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const PORT = 43210;
const metadata = {
  resolvedAt: "2026-10-19T00:00:00Z",
  source: "listen-port-conformance",
  runtime: 4,
} as const;
const mechanisms: Readonly<
  Record<
    string,
    {
      readonly env?: string;
      readonly value?: string;
      readonly command?: string;
      readonly build?: string;
      readonly generatedFile?: { readonly stepId: string; readonly contains: string };
    }
  >
> = {
  mysql: { env: "MYSQL_TCP_PORT" },
  mariadb: { env: "MYSQL_TCP_PORT" },
  postgres: { env: "PGPORT" },
  mssql: { env: "MSSQL_TCP_PORT" },
  rabbitmq: { env: "RABBITMQ_NODE_PORT" },
  adminer: { command: `php -S [::]:${PORT}` },
  phpmyadmin: { env: "APACHE_PORT" },
  elasticsearch: { env: "http.port" },
  opensearch: { env: "http.port" },
  node: { env: "PORT" },
  python: { env: "PORT" },
  ruby: { env: "PORT" },
  go: { env: "PORT" },
  dotnet: { env: "ASPNETCORE_HTTP_PORTS" },
  "python/django": { env: "PORT" },
  "python/fastapi": { env: "UVICORN_PORT" },
  "python/flask": { env: "FLASK_RUN_PORT" },
  "ruby/rails": { env: "PORT" },
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
  tomcat: { build: `port="${PORT}"` },
  "static:caddy": {
    generatedFile: { stepId: LANDO_ERROR_PAGES_BUILD_STEP_ID, contains: `http://:${PORT} {` },
  },
};
const exemptions: Readonly<Record<string, string>> = {
  compose: "Raw Compose has no bundled launcher.",
  lando: "The base service has no bundled daemon.",
};
const commandText = (command: string | readonly string[] | undefined): string =>
  typeof command === "string" ? command : (command ?? []).join(" ");

const listenerVariants = (family: string): readonly Partial<Pick<ServiceConfig, "via" | "framework">>[] => {
  switch (family) {
    case "php":
      return [{}, { via: "fpm" }, { via: "cli" }];
    case "python":
      return [{}, { framework: "django" }, { framework: "fastapi" }, { framework: "flask" }];
    case "ruby":
      return [{}, { framework: "rails" }];
    default:
      return [{}];
  }
};

describe("bundled catalog listen-port conformance", () => {
  for (const [id, serviceType] of serviceTypes) {
    const family = id.split(":")[0] ?? id;
    if (Object.hasOwn(exemptions, family)) {
      test.each([{}, { endpoints: [] }])(
        `${id} selects an authored self port without declaring endpoints: %j`,
        async (endpoints) => {
          const select = serviceType.plannedPort;
          if (select === undefined) throw new Error(`Missing selector for ${id}`);
          for (const port of [undefined, PORT]) {
            const service = Schema.decodeUnknownSync(ServiceConfig)({
              type: id,
              image: "alpine:3",
              ...endpoints,
              ...(port === undefined ? {} : { port }),
            });
            expect(select(service)).toBe(port);
            const plan = await composeServicePlan({
              serviceType,
              service,
              serviceName: "server",
              appName: "port-test",
              appRoot: "/srv/apps/port-test",
              metadata,
            });
            expect(plan.endpoints).toEqual([]);
            expect(plan.listenerAuthority).toBeUndefined();
            expect(plan.readiness).toBeUndefined();
          }
        },
      );
      continue;
    }
    for (const variant of listenerVariants(family)) {
      test(`${id} ${variant.framework ?? variant.via ?? "default"} predicts its primary endpoint`, async () => {
        const select = serviceType.plannedPort;
        if (select === undefined) throw new Error(`Missing selector for ${id}`);
        for (const port of [undefined, PORT]) {
          const service = Schema.decodeUnknownSync(ServiceConfig)({
            type: id,
            ...variant,
            ...(port === undefined ? {} : { port }),
            ...(family === "minio" ? { image: "example.test/minio:fixture" } : {}),
            ...(family === "varnish" ? { backend: "web" } : {}),
          });
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
            service,
            serviceName: "server",
            appName: "port-test",
            appRoot: "/srv/apps/port-test",
            metadata,
          });
          const primary = plan.endpoints.find(
            (endpoint) => "primary" in endpoint && endpoint.primary === true,
          );
          const planned = select(service);
          if (variant.via === "cli") expect(planned).toBeUndefined();
          else expect(planned).toBeNumber();
          expect(primary).toEqual(
            planned === undefined ? undefined : expect.objectContaining({ port: planned }),
          );
        }
      });
    }
    test(`${id} classifies and honors an authored non-default listen port`, async () => {
      const mechanism = mechanisms[id] ?? mechanisms[family];
      if (mechanism === undefined) throw new Error(`Missing listen-port mechanism for ${id}`);
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
          ...(family === "minio" ? { image: "example.test/minio:fixture" } : {}),
          ...(family === "varnish" ? { backend: "web" } : {}),
        }),
        serviceName: "server",
        appName: "port-test",
        appRoot: "/srv/apps/port-test",
        metadata,
      });
      expect(plan.endpoints).toContainEqual(expect.objectContaining({ port: PORT, primary: true }));
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
      if (mechanism.generatedFile !== undefined) {
        const features = Schema.decodeUnknownSync(
          Schema.Struct({
            buildSteps: Schema.Array(Schema.Struct({ id: Schema.String, command: Schema.Unknown })),
          }),
        )(plan.extensions["@lando/core/service-features"]);
        const step = features.buildSteps.find(
          (candidate) => candidate.id === mechanism.generatedFile?.stepId,
        );
        const command = commandText(Schema.decodeUnknownSync(Schema.Array(Schema.String))(step?.command));
        const written = [...command.matchAll(/'([A-Za-z0-9+/=]{16,})'/gu)]
          .map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"))
          .join("\n");
        expect(written).toContain(mechanism.generatedFile.contains);
      }
    });
  }

  const contracts = listenerContracts();
  for (const [key, mechanism] of Object.entries(mechanisms)) {
    const variable = mechanism.env;
    if (variable === undefined) continue;
    const [family = key, framework] = key.split("/");
    const serviceType = [...serviceTypes.values()].find(
      (type) => type.id.split(":")[0] === family && type.id !== "node",
    );
    if (serviceType === undefined) throw new Error(`Missing service type ${family}`);
    for (const [condition, value] of [
      ["unequal", mechanism.value === undefined ? "43211" : "0.0.0.0:43211"],
      ["malformed", "not-a-port"],
    ]) {
      test(`${key} rejects ${condition} authored ${variable} at its environment field`, async () => {
        await expect(
          composeServicePlan({
            serviceType,
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type: serviceType.id,
              port: PORT,
              ...(framework === undefined ? {} : { framework }),
              environment: { [variable]: value },
            }),
            serviceName: "server",
            appName: "port-test",
            appRoot: "/srv/apps/port-test",
            metadata,
          }),
        ).rejects.toMatchObject({
          issues: [expect.objectContaining({ path: ["environment", variable] })],
        });
      });
    }
  }
  for (const family of new Set([...serviceTypes.keys()].map((id) => id.split(":")[0] ?? id))) {
    test(`${family} declares its listener contract or an explicit exemption`, () => {
      expect(contracts[family] ?? exemptions[family]).toBeDefined();
    });
  }
  for (const [family, contract] of Object.entries(contracts)) {
    test(`${family} resolves to a registered service family and describes its applicability`, () => {
      expect([...serviceTypes.keys()].some((id) => id.split(":")[0] === family.split("/")[0])).toBe(true);
      expect(contract.when).toEqual(expect.any(String));
      expect(contract.when?.trim()).not.toBe("");
    });
    for (const reserved of contract.reserved ?? []) {
      test(`${family} rejects its default ${reserved.use} port as primary`, async () => {
        const serviceType = serviceTypes.get(family);
        if (serviceType === undefined) throw new Error(`Missing service type ${family}`);
        await expect(
          composeServicePlan({
            serviceType,
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type: family,
              port: reserved.port,
              ...(family === "minio" ? { image: "example.test/minio:fixture" } : {}),
              ...(family === "varnish" ? { backend: "web" } : {}),
            }),
            appRoot: "/srv/apps/port-test",
            appName: "port-test",
            serviceName: "server",
            metadata,
          }),
        ).rejects.toMatchObject({
          issues: [
            expect.objectContaining({ path: ["port"], message: expect.stringContaining(reserved.use) }),
          ],
        });
      });
    }
  }
});
