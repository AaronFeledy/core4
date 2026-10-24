import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const cases = [
  { type: mysqlServiceType, admin: "mysqladmin", client: "mysql" },
  { type: mariadbServiceType, admin: "mariadb-admin", client: "mariadb" },
] as const;
const creds = {
  user: "app-user",
  password: "app p@ss $value 'quoted'",
  database: "appdb",
  rootPassword: "distinct-root-only",
};
const metadata = { resolvedAt: "2026-10-01T00:00:00Z", source: "client-env", runtime: 4 as const };

test.each(cases)(
  "$type.id keeps client-only passwords out of server initialization",
  async ({ type, client }) => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: type.id, port: 13306, creds });

    const plan = await composeServicePlan({
      serviceType: type,
      service,
      appRoot: "/srv/client-env",
      appName: "client-env",
      serviceName: "db",
      metadata,
    });
    const resolution = await Effect.runPromise(
      type.resolve({ name: "db", service, appRoot: "/srv/client-env", appName: "client-env", metadata }),
    );

    expect(plan.environment.MYSQL_PWD).toBeUndefined();
    expect(plan.environment.MYSQL_PASSWORD).toBe(creds.password);
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toBe(creds.rootPassword);
    expect(resolution.tooling?.[client]?.env?.MYSQL_PWD).toBe(creds.password);
  },
);

test.skipIf(process.platform === "win32").each(cases)(
  "$type.id gives only its probe process the application password",
  async ({ type, admin }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-database-probe-env-"));
    try {
      const executable = join(root, admin);
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({pwd:process.env.MYSQL_PWD,args:process.argv.slice(2)}));\n`,
      );
      await chmod(executable, 0o755);
      const plan = await composeServicePlan({
        serviceType: type,
        service: Schema.decodeUnknownSync(ServiceConfig)({ type: type.id, port: 13306, creds }),
        appRoot: root,
        appName: "client-env",
        serviceName: "db",
        metadata,
      });
      const command = plan.healthcheck?.command;
      if (command === undefined || typeof command === "string") throw new Error("Expected argv probe");

      const child = Bun.spawn([...command], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          MYSQL_PASSWORD: creds.password,
          MYSQL_USER: creds.user,
          MYSQL_PWD: "ambient-wrong-password",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const observed = Schema.decodeUnknownSync(
        Schema.Struct({ pwd: Schema.String, args: Schema.Array(Schema.String) }),
      )(JSON.parse(stdout));

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(observed.pwd).toBe(creds.password);
      expect(observed.args).toEqual(["ping", "-h", "127.0.0.1", "-P", "13306", "-u", creds.user, "--silent"]);
      expect(observed.args).not.toContain(creds.password);
      expect(command.join(" ")).not.toContain(creds.password);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
