import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { compileTestLandofile } from "./support/compiled-landofile.ts";

const planMariadb = async (service: Readonly<Record<string, unknown>>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "mariadb-upgrade",
    services: { db: { type: "mariadb", ...service } },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(compileTestLandofile(landofile), {
        ...TestRuntimeProvider.capabilities,
        artifactBuild: true,
      }),
    ).pipe(
      Effect.provide(
        AppPlannerLayer.layer.pipe(Layer.provide(Layer.succeed(PathsService, makeLandoPaths()))),
      ),
      Effect.provide(PluginRegistryLayer.layer),
    ),
  );
  const db = plan.services[ServiceName.make("db")];
  if (db === undefined) throw new Error("db service missing from plan");
  return db;
};

test("keeps an authored MariaDB auto-upgrade opt-out", async () => {
  const plan = await planMariadb({ environment: { MARIADB_AUTO_UPGRADE: "0" } });
  expect(plan.environment.MARIADB_AUTO_UPGRADE).toBe("0");
});

test.each([
  "mariadb:11.4",
  "mariadb:10.11",
  "docker.io/library/mariadb:11.8",
  `mariadb@sha256:${"a".repeat(64)}`,
])("plans the downgrade guard without replacing the entrypoint for %s", async (image) => {
  const plan = await planMariadb({ image, port: 4306 });
  expect(plan.command).toEqual(["sh", "-c", expect.any(String), "lando-mariadb", "mariadbd", "--port=4306"]);
  expect(plan.entrypoint).toBeUndefined();
});

test.each([
  { image: "bitnami/mariadb" },
  { image: "ghcr.io/x/mariadb" },
  { image: "myorg/mariadb" },
  { build: { dockerfile_inline: "FROM mariadb:11.4" } },
  { image: "mariadb:11.4", build: { app: "true" } },
])("leaves the image process unchanged but defaults auto-upgrade for %j", async (service) => {
  const plan = await planMariadb(service);
  expect(plan.command).toBeUndefined();
  expect(plan.entrypoint).toBeUndefined();
  expect(plan.environment.MARIADB_AUTO_UPGRADE).toBe("1");
});

test.each(["--port=3307", "-P3307", "--defaults-file=/tmp/my.cnf"])(
  "rejects reserved MariaDB extraArgs token %s",
  async (arg) => {
    await expect(planMariadb({ extraArgs: ["--max-connections=10", arg] })).rejects.toMatchObject({
      _tag: "LandofileValidationError",
      issues: [expect.objectContaining({ path: ["services", "db", "extraArgs", 1] })],
    });
  },
);

test("rejects extraArgs for an official noncatalog tag", async () => {
  await expect(
    planMariadb({ image: "mariadb:10.11", extraArgs: ["--max-connections=10"] }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [expect.objectContaining({ path: ["services", "db", "extraArgs"] })],
  });
});

test.skipIf(process.platform === "win32").each([
  ["mariadb_upgrade_info", "11.4.13-MariaDB", "10.11", "11.4"],
  ["mysql_upgrade_info", "10.11.19-MariaDB", "10.6", "10.11"],
  ["mariadb_upgrade_info", "10.11.23-MariaDB", "10.11", undefined],
  ["mysql_upgrade_info", "10.6.19-MariaDB", "10.11", undefined],
  [undefined, undefined, "10.11", undefined],
  ["mariadb_upgrade_info", "garbage", "10.11", undefined],
] as const)("checks datadir record %s (%s) against running %s", async (record, value, running, newer) => {
  const plan = await planMariadb({ extraArgs: ["--max-connections=10", "--init-connect=SELECT 1"] });
  if (!Array.isArray(plan.command)) throw new Error("MariaDB downgrade guard requires a command argv");

  const datadir = await mkdtemp(join(tmpdir(), "lando-mariadb-upgrade-"));
  try {
    if (record !== undefined) await Bun.write(join(datadir, record), `${value}\n`);
    const daemon = join(datadir, "mariadbd");
    const entrypoint = join(datadir, "docker-entrypoint.sh");
    await Bun.write(
      daemon,
      `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '%s\\n' 'mariadbd  Ver ${running}.19-MariaDB-ubu2204 for debian-linux-gnu'\n`,
    );
    await Bun.write(entrypoint, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    await Promise.all([chmod(daemon, 0o755), chmod(entrypoint, 0o755)]);

    const result = Bun.spawnSync(
      plan.command.map((arg, index) => (index === 2 ? arg.replaceAll("/var/lib/mysql", datadir) : arg)),
      {
        env: {
          PATH: [datadir, "/usr/bin", "/bin"].join(delimiter),
          LANDO_SERVICE_NAME: "db",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (newer !== undefined) {
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      const refusal = result.stderr.toString();
      expect(refusal).toContain(`MariaDB ${running}`);
      expect(refusal).toContain(`MariaDB ${newer}`);
      expect(refusal).toContain(`services.db.image to mariadb:${newer}`);
      expect(refusal).toContain("every service's data");
      for (const action of ["lando db:export", "lando destroy --volumes", "lando db:import"]) {
        expect(refusal).toContain(action);
      }
    } else {
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trimEnd().split("\n")).toEqual([
        "mariadbd",
        "--port=3306",
        "--max-connections=10",
        "--init-connect=SELECT 1",
      ]);
    }
  } finally {
    await rm(datadir, { recursive: true, force: true });
  }
});
