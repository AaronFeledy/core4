import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, planAppIdentity } from "@lando/sdk/schema";
import { type EphemeralRunSpec, StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect } from "effect";
import type { SqlCommandDeps } from "../../src/command-types.ts";
import { makeSqlTestDeps } from "./fakes.ts";

export const sqlitePayloadFixture = async (
  options: { readonly integrity?: string; readonly exists?: boolean } = {},
) => {
  const harness = makeSqlTestDeps({ password: "secret", initiallyRunning: false });
  const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
  const root = harness.root;
  await mkdir(join(root, "data"));
  using database = new Database(":memory:");
  database.exec(
    "CREATE TABLE items(name TEXT); INSERT INTO items(rowid,name) VALUES(42,'first'),(900,'last');",
  );
  const bytes = new Uint8Array(database.serialize());
  const databasePath = join(root, "data/site.sqlite");
  if (options.exists !== false) await writeFile(databasePath, bytes);
  const commands: (readonly string[])[] = [];
  const paths = makeLandoPaths({
    userConfRoot: join(root, "conf"),
    userDataRoot: join(root, "state"),
    userCacheRoot: join(root, "cache"),
    env: {},
  });
  const target = {
    kind: "file",
    name: "appserver",
    type: "php:8.3",
    family: "sqlite",
    path: "data/site.sqlite",
  } as const;
  const service = {
    name: target.name,
    type: target.type,
    sqlite: { path: target.path },
    environment: {},
    extensions: {},
    storage: [],
    mounts: [{ type: "bind", source: root, target: "/app", readOnly: false, role: "app" }],
  } as const;
  const inspect = () =>
    Effect.succeed({ status: "stopped" as const, running: false, containerId: "service" });
  const run = (spec: EphemeralRunSpec) =>
    Effect.tryPromise({
      try: async () => {
        commands.push(spec.command);
        if (spec.command.includes("sqlite-owner"))
          return {
            exitCode: 0,
            stdout: `${options.exists === false ? "missing\n" : ""}100:200\n`,
            stderr: "",
          };
        const scratch = spec.binds?.[0];
        if (scratch === undefined) throw new Error("Missing scratch bind");
        const hostPath = (path: string) => join(scratch.source, path.slice(scratch.target.length));
        const last = spec.command.at(-1) ?? "";
        if (last.startsWith(".backup main ")) {
          const path: unknown = JSON.parse(last.slice(".backup main ".length));
          if (typeof path !== "string") throw new Error("Invalid backup path");
          await writeFile(hostPath(path), bytes);
        } else if (last === "PRAGMA main.integrity_check;") {
          return { exitCode: 0, stdout: options.integrity ?? "ok\n", stderr: "" };
        } else if (spec.command.includes("sqlite-dump")) {
          await writeFile(
            hostPath(last),
            "BEGIN TRANSACTION;\nCOMMIT;\nPRAGMA user_version=0;\nPRAGMA application_id=0;\n",
          );
        } else if (spec.stdinStream !== undefined && spec.command.length === 3) {
          using staged = new Database(":memory:");
          let sql = "";
          for await (const chunk of spec.stdinStream) sql += new TextDecoder().decode(chunk);
          staged.exec(sql);
          await writeFile(hostPath(last), staged.serialize());
        } else if (spec.stdinStream !== undefined) {
          for await (const chunk of spec.stdinStream) {
            const sql = new TextDecoder().decode(chunk);
            const outputs = [...sql.matchAll(/^\.output (".*")$/gmu)].map((match) => {
              const path: unknown = JSON.parse(match[1] ?? "null");
              if (typeof path !== "string") throw new Error("Invalid handshake path");
              return hostPath(path);
            });
            if (sql.includes("SELECT sqlite_version();")) {
              const [version, ready] = outputs;
              if (version === undefined || ready === undefined) throw new Error("Missing handshake");
              await writeFile(version, "3.53.4\n");
              await writeFile(ready, "ready\n");
            } else {
              const receipt = outputs.at(-1);
              const id = /SELECT '([a-z0-9-]+)' FROM temp.lando_integrity_count/u.exec(sql)?.[1];
              if (receipt === undefined || id === undefined)
                throw new Error("Expected binary restore receipt");
              await writeFile(receipt, id);
            }
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      catch: (cause) => cause,
    });
  const identity = planAppIdentity({ root: AbsolutePath.make(root) });
  const deps: SqlCommandDeps = {
    ...harness.deps,
    inspect,
    plan: { ...harness.deps.plan, identity, services: { appserver: service } },
    sqlite: {
      applied: { root: identity.appRoot, identity },
      inspect,
      run,
      paths,
      stateStore,
      privateFileAccess: harness.deps.privateFileAccess,
      pullArtifact: () => Effect.succeed({ digest: sqliteHelperImage.digest }),
    },
  };
  return { root, deps, target, bytes, commands, databasePath };
};
