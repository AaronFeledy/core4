import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { retireTempRoots } from "@lando/engine/testing/temp-root-retirement";

const socket = resolveLiveProviderSocket();
const required = process.env.LANDO_GUIDE_E2E === "1";
const useManaged = process.env.LANDO_TEST_USE_REAL_ROOTS === "1";
const binary = process.env.LANDO_SCENARIO_E2E_BINARY ?? resolve(import.meta.dir, "../../../core/dist/lando");
const url = "http://127.0.0.1:8080/";
const token = (page: string) => {
  const value = /name=['"]token['"] value=['"]([\d:]+)['"]/u.exec(page)?.[1];
  if (value === undefined) throw new TypeError("Adminer did not render a CSRF token");
  return value;
};

test.skipIf(socket === undefined && !required)(
  "Adminer signs into each discovered database and writes SQLite as the project user",
  async () => {
    if (socket === undefined) throw new TypeError("An answering LANDO_TEST_PODMAN_SOCKET is required");
    const root = await mkdtemp(join(tmpdir(), "lando-adminer-live-"));
    const app = join(root, "app");
    const name = `adminer-live-${crypto.randomUUID().slice(0, 8)}`;
    const password = `live-${crypto.randomUUID()}`;
    const env = {
      ...process.env,
      BUN_BE_BUN: undefined,
      ...(useManaged
        ? { LANDO_PROVIDER: "lando" }
        : {
            LANDO_USER_CONF_ROOT: join(root, "config"),
            LANDO_USER_DATA_ROOT: join(root, "state"),
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
            LANDO_PROVIDER: "podman",
            LANDO_CONFIG__default_provider_id: "podman",
            DOCKER_HOST: `unix://${socket.socketPath}`,
          }),
      LANDO_SECRET_ADMINER_LIVE_DB: password,
    };
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn([binary, ...args], {
        cwd: app,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 180_000,
      });
      const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(out + err).not.toContain(password);
      expect(code, `${args[0]}: ${out}${err}`).toBe(0);
      return out;
    };
    const curl = (...args: string[]) =>
      cli("exec", "adminer", "--", "curl", "-fsSL", "--max-time", "15", ...args);
    await mkdir(join(app, "data"), { recursive: true });
    const path = join(app, "data", "site.sqlite");
    using sqlite = new Database(path);
    sqlite.run(
      "PRAGMA journal_mode=WAL; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('sqlite-note');",
    );
    sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const landofile = `name: ${name}
router:
  enabled: false
services:
  reports:
    type: postgres
    creds:
      password: '\${secret:ADMINER_LIVE_DB}'
  store:
    type: mariadb
  files:
    type: lando
    image: alpine:3.20
    command: [sleep, infinity]
    appMount:
      target: /workspace
    sqlite:
      path: data/site.sqlite
  adminer:
    type: adminer:6
`;
    await Bun.write(join(app, ".lando.yml"), landofile);
    try {
      await cli("start");
      const info = await cli("info", "--format=json");
      expect(info).toMatch(/"password":"\[redacted\]"/u);
      expect(info).toMatch(/"projectUser":\{"name":"adminer","uid":100,"gid":101\}/u);
      const planned = await cli("app:config", "--format=json");
      expect(planned).toContain('"reference":"ADMINER_LIVE_DB"');
      expect(planned).not.toContain(password);
      await cli("app:cache:refresh", "--format=json");
      await cli("logs", "--service", "adminer");
      await cli("logs", "--service", "reports");
      expect(await curl("--no-fail", "-o", "/dev/null", "-w", "%{http_code}", `${url}adminer.php`)).toBe(
        "404",
      );
      await cli("psql", "-c", "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('postgres-note')");
      await cli("mariadb", "-e", "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mariadb-note')");
      const cases = [
        [
          "files",
          "files (SQLite: /workspace/data/site.sqlite)",
          "sqlite-note",
          "sqlite",
          "",
          "/workspace/data/site.sqlite",
        ],
        ["reports", "reports (PostgreSQL)", "postgres-note", "pgsql", "lando", name],
        ["store", "store (MariaDB)", "mariadb-note", "server", "lando", name],
      ] as const;
      for (const [service, label, row, driver, username, db] of cases) {
        const jar = `/tmp/${service}.cookies`;
        const cookies = ["-c", jar, "-b", jar];
        const form = await curl(...cookies, url);
        expect(form).toContain("name='lando_target'");
        for (const [, option] of cases) expect(form).toContain(option);
        expect(form).toContain(label);
        await curl(
          ...cookies,
          "--data",
          new URLSearchParams({ lando_target: service, token: token(form) }).toString(),
          url,
        );
        const query = new URLSearchParams({ [driver]: service, username, db });
        expect(await curl(...cookies, `${url}?${query}&select=notes`)).toContain(row);
        if (driver === "sqlite") {
          const sqlUrl = `${url}?${query}&sql=`;
          const sql = await curl(...cookies, sqlUrl);
          await curl(
            ...cookies,
            "--data",
            new URLSearchParams({
              token: token(sql),
              query: "INSERT INTO notes VALUES ('saved-in-adminer')",
            }).toString(),
            sqlUrl,
          );
          expect(sqlite.query("SELECT body FROM notes ORDER BY rowid").all()).toEqual([
            { body: "sqlite-note" },
            { body: "saved-in-adminer" },
          ]);
          const wal = await stat(`${path}-wal`);
          expect(wal.size).toBeGreaterThan(0);
          expect(wal.uid).toBe((await stat(path)).uid);
          expect(wal.gid).toBe((await stat(path)).gid);
        }
      }
    } finally {
      let fixtureCleanupFailure: string | undefined;
      try {
        await cli("destroy", "-y", "--volumes");
      } catch (error) {
        fixtureCleanupFailure = String(error);
      } finally {
        if (useManaged) {
          await rm(root, { recursive: true, force: true });
          expect(fixtureCleanupFailure).toBeUndefined();
        } else {
          const retirement = await retireTempRoots({
            directory: root,
            endpoint: socket.socketPath,
            env,
            command: [binary],
          });
          expect(
            [...retirement.retained, ...retirement.failed],
            JSON.stringify({ root, endpoint: socket.socketPath, ...retirement }),
          ).toEqual([]);
        }
      }
    }
  },
  420_000,
);
