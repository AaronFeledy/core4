import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { phpDbClientBuildStepsForSources } from "../src/services/php-db-client-sources.ts";

const podmanEnv = process.env.LANDO_TEST_MYSQL_ARM64_PODMAN;

const requireManagedPodman = async (): Promise<string> => {
  if (podmanEnv === undefined || podmanEnv.length === 0) {
    throw new Error("LANDO_TEST_MYSQL_ARM64_PODMAN is required");
  }
  if (!isAbsolute(podmanEnv)) {
    throw new Error("LANDO_TEST_MYSQL_ARM64_PODMAN must be an absolute executable");
  }
  await access(podmanEnv, constants.X_OK);
  return podmanEnv;
};

const run = async (podman: string, args: readonly string[]) => {
  const child = Bun.spawn([podman, ...args], { stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  return stdout.trim();
};

const discard = async (podman: string, args: readonly string[]): Promise<void> => {
  const child = Bun.spawn([podman, ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  await child.exited;
};

test.skipIf(podmanEnv === undefined).each([
  ["8.0", "8.0.46"],
  ["8.4", "8.4.11"],
  ["9.7", "9.7.2"],
])(
  "Given ARM stock PHP and MySQL %s, when connecting with default auth, then queries and dump round trips succeed",
  async (series, version) => {
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("arm64");
    const podman = await requireManagedPodman();
    const root = await mkdtemp(join(tmpdir(), "lando-mysql-arm-live-"));
    const id = `lando-mysql-arm-${crypto.randomUUID()}`;
    const image = `localhost/${id}:test`;
    const [step] = phpDbClientBuildStepsForSources([{ family: "mysql", version: series }]);
    try {
      await Bun.write(
        join(root, "Containerfile"),
        `FROM php:8.3-apache-bookworm\nRUN ${String(step?.command)}\n`,
      );
      await run(podman, ["build", "-t", image, root]);
      await run(podman, ["network", "create", id]);
      await run(podman, [
        "run",
        "-d",
        "--name",
        id,
        "--network",
        id,
        "--network-alias",
        "db",
        "-e",
        "MYSQL_ROOT_PASSWORD=lando-test",
        "-e",
        "MYSQL_DATABASE=lando",
        "-e",
        "MYSQL_USER=lando",
        "-e",
        "MYSQL_PASSWORD=lando-test",
        "--health-cmd",
        "mysqladmin ping -h 127.0.0.1 -plando-test",
        "--health-interval",
        "2s",
        "--health-retries",
        "60",
        `mysql:${version}`,
      ]);
      await run(podman, ["wait", "--condition=healthy", id]);
      const output = await run(podman, [
        "run",
        "--rm",
        "--network",
        id,
        "-e",
        "MYSQL_PWD=lando-test",
        image,
        "sh",
        "-ec",
        [
          'test "$(uname -m)" = aarch64',
          "command -v mysql mysqladmin mysqldump",
          "mysql --version",
          "mysqladmin --version",
          "mysqldump --version",
          "ldd /usr/bin/mysql",
          "test -d /usr/lib64/mysql/plugin",
          `mysql -h db -u root -Nse "SELECT plugin FROM mysql.user WHERE user='lando'"`,
          `mysql --ssl-mode=DISABLED --get-server-public-key -h db -u lando lando -e "CREATE TABLE proof (id INT); INSERT INTO proof VALUES (957)"`,
          series === "9.7"
            ? "mysqldump -h db -u lando --single-transaction --set-gtid-purged=OFF --no-tablespaces --skip-masking-policies lando > /tmp/proof.sql"
            : "mysqldump -h db -u lando --single-transaction --set-gtid-purged=OFF --no-tablespaces lando > /tmp/proof.sql",
          "mysql -h db -u lando lando -e 'DROP TABLE proof'",
          "mysql -h db -u lando lando < /tmp/proof.sql",
          "mysql -h db -u lando -Nse 'SELECT id FROM lando.proof; SELECT VERSION()'",
        ].join(" && "),
      ]);
      expect(output).toContain(version);
      expect(output).toContain("caching_sha2_password");
      expect(output.split("\n")).toContain("957");
      expect(output).not.toContain("not found");
    } finally {
      await discard(podman, ["rm", "-f", "--volumes", id]);
      await discard(podman, ["network", "rm", id]);
      await discard(podman, ["rmi", "--force", image]);
      await rm(root, { recursive: true, force: true });
    }
  },
  1_200_000,
);
