import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

// The probe runs in Linux containers; this test executes its POSIX payload on the host.
test.skipIf(process.platform === "win32").each([
  { addresses: "10.0.0.2 10.0.1.2", ok: 1, clientExit: 0, exit: 0, host: "10.0.0.2" },
  { addresses: "fd00::2 fd00::3", ok: 1, clientExit: 0, exit: 0, host: "[fd00::2]" },
  { addresses: "10.0.0.2", ok: 0, clientExit: 0, exit: 1, host: "10.0.0.2" },
  { addresses: "10.0.0.2", ok: 1, clientExit: 33, exit: 33, host: "10.0.0.2" },
  { addresses: "", ok: 1, clientExit: 0, exit: 1, host: undefined },
])("propagates protocol status with address=$addresses ok=$ok clientExit=$clientExit", async (input) => {
  // Given: only address discovery and the external Mongo client are substituted.
  const root = await mkdtemp(join(tmpdir(), "lando-mongo-probe-"));
  try {
    const hostname = join(root, "hostname");
    const mongosh = join(root, "mongosh");
    await writeFile(hostname, '#!/bin/sh\ntest "$1" = -I || exit 2\nprintf "%s\\n" "$ADDRESSES"\n');
    await writeFile(
      mongosh,
      `#!${process.execPath}
const args = process.argv.slice(2);
console.log(JSON.stringify({ args, home: process.env.HOME }));
if (Number(process.env.CLIENT_EXIT)) process.exit(Number(process.env.CLIENT_EXIT));
const expression = args[args.indexOf("--eval") + 1];
new Function("db", "quit", expression)(
  { adminCommand: () => ({ ok: Number(process.env.PING_OK) }) },
  (code) => process.exit(code),
);
`,
    );
    await chmod(hostname, 0o755);
    await chmod(mongosh, 0o755);
    const config = Schema.decodeUnknownSync(LandofileShape)({
      name: "probe",
      services: {
        db: {
          type: "mongodb",
          port: 37017,
          creds: { user: "probe-user", password: "probe-secret", database: "probe-db" },
          environment: { HOME: "/authored-home" },
        },
      },
    });
    const service = config.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("Mongo service is missing");
    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: root,
      serviceName: "db",
      metadata: { resolvedAt: "2026-05-28T00:00:00Z", source: "probe", runtime: 4 },
    });
    const command = plan.healthcheck?.command;
    if (command === undefined || typeof command === "string")
      throw new Error("Mongo argv healthcheck is missing");

    // When
    const child = Bun.spawn([...command], {
      env: {
        ...process.env,
        ...plan.environment,
        PATH: `${root}:${process.env.PATH}`,
        ADDRESSES: input.addresses,
        PING_OK: String(input.ok),
        CLIENT_EXIT: String(input.clientExit),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    // Then
    expect({ exitCode, stderr }).toEqual({ exitCode: input.exit, stderr: "" });
    expect(plan.environment.HOME).toBe("/authored-home");
    expect(command.join(" ")).not.toContain("probe-secret");
    expect(command.join(" ")).not.toContain("probe-user");
    if (input.host === undefined) {
      expect(stdout).toBe("");
    } else {
      const observed = Schema.decodeUnknownSync(
        Schema.Struct({
          args: Schema.Array(Schema.String),
          home: Schema.String,
        }),
      )(JSON.parse(stdout));
      expect(observed.home).toBe("/tmp");
      expect(observed.args).toContain("--norc");
      expect(observed.args).toContain(
        `mongodb://${input.host}:37017/admin?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
