import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { sqliteHelperImage } from "@lando/container-runtime/data-plane";

import { packSqliteTar, unpackSqliteTar } from "../src/sqlite-archive.ts";
import { isSqliteDatabaseHeader } from "../src/sqlite-header.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET || undefined;
const dockerHost =
  socket === undefined ? undefined : socket.startsWith("unix://") ? socket : `unix://${socket}`;

test.skipIf(dockerHost === undefined)(
  `sqlite helper import/export/snapshot/restore round trip${dockerHost === undefined ? " (SKIP: LANDO_TEST_DOCKER_SOCKET required)" : ""}`,
  async () => {
    if (dockerHost === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
    const dir = await mkdtemp(join(tmpdir(), "lando-sqlite-it-"));
    const env = { ...process.env, DOCKER_HOST: dockerHost };
    const docker = async (args: ReadonlyArray<string>, stdin?: string) => {
      const proc = Bun.spawn(["docker", ...args], {
        cwd: dir,
        env,
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    try {
      const pull = await docker(["pull", sqliteHelperImage.ref]);
      expect(pull.exitCode).toBe(0);

      const sql =
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('ok');";
      const create = await docker(
        [
          "run",
          "--rm",
          "--entrypoint",
          "sqlite3",
          "-v",
          `${dir}:/data`,
          sqliteHelperImage.ref,
          "/data/app.sqlite",
        ],
        sql,
      );
      expect(create.exitCode).toBe(0);

      const header = new Uint8Array(await Bun.file(join(dir, "app.sqlite")).arrayBuffer()).subarray(0, 16);
      expect(isSqliteDatabaseHeader(header)).toBe(true);

      const dumped = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/app.sqlite",
        ".dump",
      ]);
      expect(dumped.exitCode).toBe(0);
      expect(dumped.stdout).toContain("CREATE TABLE items");

      const vacuum = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/app.sqlite",
        "VACUUM INTO '/data/snap.sqlite';",
      ]);
      expect(vacuum.exitCode).toBe(0);

      const snapshotBytes = new Uint8Array(await Bun.file(join(dir, "snap.sqlite")).arrayBuffer());
      expect(isSqliteDatabaseHeader(snapshotBytes)).toBe(true);
      const archive = packSqliteTar(snapshotBytes);
      const restored = unpackSqliteTar(archive);
      expect(restored).toEqual(snapshotBytes);
      await writeFile(join(dir, "restored.sqlite"), restored ?? new Uint8Array());

      const count = await docker([
        "run",
        "--rm",
        "--entrypoint",
        "sqlite3",
        "-v",
        `${dir}:/data`,
        sqliteHelperImage.ref,
        "/data/restored.sqlite",
        "SELECT name FROM items;",
      ]);
      expect(count.exitCode).toBe(0);
      expect(count.stdout.trim()).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
