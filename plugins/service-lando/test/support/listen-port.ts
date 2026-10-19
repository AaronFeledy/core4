import { describe, expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Schema } from "effect";
import { Effect } from "effect";
import { composeServicePlan } from "./compose-harness.ts";

export const nativeListenPortSuite = (input: {
  readonly serviceType: ServiceType;
  readonly variable: string;
  readonly defaultPort: number;
  readonly serverCommand?: string;
}) => {
  const type = input.serviceType.id;
  const port = input.defaultPort + 1000;
  const plan = (definition: Record<string, unknown>) =>
    composeServicePlan({
      serviceType: input.serviceType,
      service: Schema.decodeUnknownSync(ServiceConfig)({ type, ...definition }),
      serviceName: "db",
      appName: "port-test",
      appRoot: "/srv/apps/port-test",
      metadata: { resolvedAt: "2026-10-19T00:00:00Z", source: "listen-port", runtime: 4 },
    });
  describe(`${type} native listen port`, () => {
    test("keeps the published listener when no port is authored", async () => {
      const result = await plan({});
      expect(result.environment[input.variable]).toBe(String(input.defaultPort));
      expect(result.command).toBeUndefined();
    });
    test.each([
      { port },
      { environment: { [input.variable]: String(port) } },
      { port, environment: { [input.variable]: String(port) } },
    ])("moves the listener and endpoint for %j", async (definition) => {
      const result = await plan(definition);
      expect(result.environment[input.variable]).toBe(String(port));
      expect(result.endpoints).toContainEqual(expect.objectContaining({ port }));
      if (["mysql", "mariadb", "mssql"].includes(type)) {
        expect(result.environment.LANDO_DB_PORT).toBe(String(port));
      }
      if (type === "rabbitmq") {
        expect(result.endpoints).toContainEqual(expect.objectContaining({ port: 15672, name: "management" }));
      } else {
        expect(JSON.stringify(result.healthcheck?.command)).toContain(String(port));
      }
    });
    test("rejects conflicting port declarations", async () => {
      await expect(plan({ port, environment: { [input.variable]: String(port + 1) } })).rejects.toThrow(
        `environment.${input.variable}: ${port + 1}`,
      );
    });
    if (["mysql", "mariadb", "mssql"].includes(type)) {
      test("routes generated tooling to the authored native port", async () => {
        const resolution = await Effect.runPromise(
          input.serviceType.resolve({
            name: "db",
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type,
              environment: { [input.variable]: String(port) },
            }),
            appRoot: "/srv/apps/port-test",
            metadata: { resolvedAt: "2026-10-19T00:00:00Z", source: "listen-port", runtime: 4 },
          }),
        );
        const task = resolution.tooling?.[type === "mssql" ? "sqlcmd" : type];
        expect(task?.cmd).toContain(type === "mssql" ? `localhost,${port}` : String(port));
      });
    }
    test.each(["", "0", "65536", "1.5", "db", "-1"])("rejects invalid native port %j", async (value) => {
      await expect(plan({ environment: { [input.variable]: value } })).rejects.toThrow(
        "must be a TCP port number",
      );
    });
    test("preserves an authored command", async () => {
      const result = await plan({ port, command: ["custom-server", "--custom"] });
      expect(result.command).toEqual(["custom-server", "--custom"]);
    });
    test("preserves an authored entrypoint", async () => {
      const result = await plan({ port, entrypoint: ["custom-entrypoint"] });
      expect(result.entrypoint).toEqual(["custom-entrypoint"]);
      expect(result.command).toBeUndefined();
    });
    if (input.serverCommand !== undefined) {
      const serverCommand = input.serverCommand;
      test.each([{ port }, { environment: { [input.variable]: String(port) } }])(
        "makes the authored port beat an option file for %j",
        async (definition) => {
          const result = await plan({ ...definition, config: { server: "config/my.cnf" } });
          expect(result.command).toEqual([serverCommand, `--port=${port}`]);
        },
      );
      test("keeps option-file startup unchanged without an authored port", async () => {
        const result = await plan({ config: { server: "config/my.cnf" } });
        expect(result.command).toBeUndefined();
      });
      test.each(["command", "entrypoint"])(
        "does not append option-file port flags to authored %s",
        async (field) => {
          const result = await plan({
            port,
            config: { server: "config/my.cnf" },
            [field]: ["custom-server"],
          });
          expect(result[field]).toEqual(["custom-server"]);
          if (field === "entrypoint") expect(result.command).toBeUndefined();
        },
      );
    }
  });
};
