import { describe, expect, test } from "bun:test";
import { ServiceTypeError } from "@lando/sdk/errors";
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
  readonly reservedPorts?: readonly number[];
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
    test.each([{ port }, { port, environment: { [input.variable]: String(port) } }])(
      "moves the listener and endpoint for %j",
      async (definition) => {
        const result = await plan(definition);
        expect(result.environment[input.variable]).toBe(String(port));
        expect(result.endpoints).toContainEqual(expect.objectContaining({ port }));
        if (["mysql", "mariadb", "mssql"].includes(type)) {
          expect(result.environment.LANDO_DB_PORT).toBe(String(port));
        }
        if (type === "rabbitmq") {
          expect(result.endpoints).toContainEqual(
            expect.objectContaining({ port: 15672, name: "management" }),
          );
        } else {
          expect(JSON.stringify(result.healthcheck?.command)).toContain(String(port));
        }
      },
    );
    test("rejects conflicting port declarations", async () => {
      await expect(plan({ port, environment: { [input.variable]: String(port + 1) } })).rejects.toThrow(
        `Set port: ${port + 1}`,
      );
    });
    test("rejects a native variable selecting a different port without port:", async () => {
      await expect(plan({ environment: { [input.variable]: String(port) } })).rejects.toThrow(
        `Set port: ${port}`,
      );
    });
    test("accepts a native variable equal to the published default", async () => {
      const result = await plan({ environment: { [input.variable]: String(input.defaultPort) } });
      expect(result.environment[input.variable]).toBe(String(input.defaultPort));
    });
    test("rejects mismatched native variables during resolve before any feature runs", async () => {
      const result = await Effect.runPromise(
        Effect.result(
          input.serviceType.resolve({
            name: "db",
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type,
              environment: { [input.variable]: String(port) },
            }),
            appRoot: "/srv/apps/port-test",
            metadata: { resolvedAt: "2026-10-19T00:00:00Z", source: "listen-port", runtime: 4 },
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ServiceTypeError);
        expect(result.failure.message).toBe(
          `services.db.environment.${input.variable} is ${port}, but the service listens on ${input.defaultPort}. Set port: ${port} instead; Lando sets ${input.variable} from port:.`,
        );
      }
    });
    for (const reservedPort of input.reservedPorts ?? []) {
      test(`rejects a native ${input.variable} set to reserved port ${reservedPort}`, async () => {
        await expect(plan({ environment: { [input.variable]: String(reservedPort) } })).rejects.toThrow(
          "Remove it and set port: to another TCP port number",
        );
      });
      test(`rejects reserved port ${reservedPort}`, async () => {
        await expect(plan({ port: reservedPort })).rejects.toThrow("reserves for its");
      });
    }
    if (["mysql", "mariadb", "mssql"].includes(type)) {
      test("routes generated tooling to the planned port", async () => {
        const resolution = await Effect.runPromise(
          input.serviceType.resolve({
            name: "db",
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type,
              port,
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
        "which is not a TCP port number",
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
      test.each([{ port }, { port, environment: { [input.variable]: String(port) } }])(
        "makes the authored port beat an option file for %j",
        async (definition) => {
          const result = await plan({ ...definition, config: { server: "config/my.cnf" } });
          expect(result.command).toEqual([serverCommand, `--port=${port}`]);
        },
      );
      test("pins the default port when mounting an option file without port:", async () => {
        const result = await plan({ config: { server: "config/my.cnf" } });
        expect(result.command).toEqual([serverCommand, `--port=${input.defaultPort}`]);
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
