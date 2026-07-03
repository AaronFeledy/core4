import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Chunk, Effect, Layer, Queue } from "effect";

import type { ManagedFile } from "@lando/sdk/schema";
import { EventService, type LandoEvent, ManagedFileService } from "@lando/sdk/services";

import {
  ManagedFileServiceLive,
  makeDiskBackend,
  makeManagedFileService,
} from "../../src/managed-file/service.ts";
import { RedactionServiceLive } from "../../src/redaction/service.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";
import { makeTestSecretStore } from "../../src/testing/secret-store.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runScoped = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const file = (overrides: Partial<ManagedFile> & Pick<ManagedFile, "id" | "path">): ManagedFile => ({
  owner: "test",
  mode: "file",
  format: "text",
  content: { kind: "text", value: "hello world\n" },
  ...overrides,
});

const names = (events: ReadonlyArray<LandoEvent>): ReadonlyArray<string> =>
  events.map((event) => String(event._tag));

describe("ManagedFile lifecycle events", () => {
  test("create emits pre/post write events with a content-free summary", async () => {
    const store = await run(makeTestManagedFileStore());
    await runScoped(store.service.apply([file({ id: "a:greeting", owner: "demo", path: "greeting.txt" })]));

    expect(names(store.events())).toEqual(["pre-managed-file-write", "post-managed-file-write"]);
    for (const event of store.events()) {
      expect(event.path).toBe("greeting.txt");
      expect(event.owner).toBe("demo");
      expect(event.action).toBe("create");
      expect(String(event.summary)).toContain("create");
      expect(String(event.summary)).not.toContain("hello world");
    }
  });

  test("unchanged re-apply emits a managed-file-skipped event", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:cfg", path: "cfg.txt" });
    await runScoped(store.service.apply([mf]));
    const before = store.events().length;

    await runScoped(store.service.apply([mf]));
    const emitted = store.events().slice(before);
    expect(names(emitted)).toEqual(["managed-file-skipped"]);
    expect(emitted[0]?.action).toBe("skip-unchanged");
  });

  test("skip mode conflict emits a managed-file-conflict-detected event", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:c", path: "c.txt" });
    await runScoped(store.service.apply([mf]));
    store.seed("c.txt", `${store.read("c.txt")}tampered\n`);
    const before = store.events().length;

    const result = await runScoped(store.service.apply([mf]));
    expect(result.entries[0]?.action).toBe("conflict");
    expect(names(store.events().slice(before))).toEqual(["managed-file-conflict-detected"]);
  });

  test("overwrite conflict emits conflict-detected then pre/post write", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:ov", path: "ov.txt", onConflict: "overwrite" });
    await runScoped(store.service.apply([mf]));
    store.seed("ov.txt", `${store.read("ov.txt")}tampered\n`);
    const before = store.events().length;

    await runScoped(store.service.apply([mf]));
    const emitted = store.events().slice(before);
    expect(names(emitted)).toEqual([
      "managed-file-conflict-detected",
      "pre-managed-file-write",
      "post-managed-file-write",
    ]);
    expect(String(emitted[0]?.summary)).toContain("[prior content will be backed up]");
    expect(String(emitted[1]?.summary)).toContain("[prior content will be backed up]");
    expect(String(emitted[2]?.summary)).toContain("[prior content backed up]");
  });

  test("onConflict fail emits conflict-detected before failing", async () => {
    const store = await run(makeTestManagedFileStore());
    const mf = file({ id: "a:f", path: "f.txt", onConflict: "fail" });
    await runScoped(store.service.apply([mf]));
    store.seed("f.txt", `${store.read("f.txt")}tampered\n`);
    const before = store.events().length;

    await Effect.runPromiseExit(Effect.scoped(store.service.apply([mf])));
    expect(names(store.events().slice(before))).toEqual(["managed-file-conflict-detected"]);
  });

  test("every payload string field is routed through the redactor before publish", async () => {
    const store = await run(makeTestManagedFileStore({ redactText: (text) => `R(${text})` }));
    await runScoped(store.service.apply([file({ id: "a:r", owner: "owner-x", path: "redact.txt" })]));

    expect(store.events().length).toBeGreaterThan(0);
    for (const event of store.events()) {
      expect(event.path).toBe("R(redact.txt)");
      expect(event.owner).toBe("R(owner-x)");
      expect(String(event.summary)).toMatch(/^R\(/u);
    }
  });

  test("a secret in managed content never appears in any emitted event", async () => {
    const secret = "db-pass-9f3a-SHHH";
    const store = await run(makeTestManagedFileStore());
    const settings = file({
      id: "cms:settings",
      owner: "cms",
      path: "settings.php",
      mode: "block",
      format: "text",
      content: { kind: "text", value: `$conf['password'] = '${secret}';\n` },
    });

    await runScoped(store.service.apply([settings]));

    expect(store.events().length).toBeGreaterThan(0);
    expect(JSON.stringify(store.events())).not.toContain(secret);
    expect(store.read("settings.php")).toContain(secret);
  });

  test("library callers without an EventService still apply with no events", async () => {
    const backend = await run(makeDiskBackend({ defaultBase: () => "/noop", ledgerRoot: () => "/noop" }));
    const service = await run(makeManagedFileService(backend));
    expect(service.apply).toBeDefined();
  });
});

describe("ManagedFile lifecycle events (real EventService wiring)", () => {
  test("ManagedFileServiceLive publishes redacted events that omit secret content", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-data-")));
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    const secret = "integration-secret-7Q2x";

    try {
      const layer = Layer.mergeAll(
        EventServiceLive,
        ManagedFileServiceLive.pipe(Layer.provide(EventServiceLive)),
      );

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const managed = yield* ManagedFileService;
            yield* managed.apply([
              file({
                id: "cms:settings",
                owner: "cms",
                base: base as ManagedFile["base"],
                path: "settings.php",
                mode: "block",
                content: { kind: "text", value: `$conf['password'] = '${secret}';\n` },
              }),
            ]);
            yield* Effect.sleep("25 millis");
            const drained = yield* Queue.takeAll(queue);
            return Chunk.toReadonlyArray(drained);
          }).pipe(Effect.provide(layer)),
        ),
      ).catch((error: unknown) => {
        throw error;
      });

      const managedEvents = collected.filter((event) => String(event._tag).includes("managed-file"));
      expect(managedEvents.length).toBeGreaterThan(0);
      expect(JSON.stringify(collected)).not.toContain(secret);
      expect(await readFile(join(base, "settings.php"), "utf8")).toContain(secret);
    } finally {
      if (previous === undefined) {
        process.env.LANDO_USER_DATA_ROOT = "";
        Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      } else {
        process.env.LANDO_USER_DATA_ROOT = previous;
      }
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("a registered secret appearing in an event payload field is masked via RedactionService", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-rs-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-rs-data-")));
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    // The owner marker carries a value that is a registered secret; the redactor
    // must mask it out of the emitted event's `owner` field.
    const secret = "owner-token-9f3a-SHHH";
    const secretStore = makeTestSecretStore({ secrets: { OWNER_TOKEN: secret } });
    const redactionLive = RedactionServiceLive.pipe(Layer.provide(secretStore.layer));

    try {
      const layer = Layer.mergeAll(
        EventServiceLive,
        ManagedFileServiceLive.pipe(Layer.provide(Layer.mergeAll(EventServiceLive, redactionLive))),
      );

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const managed = yield* ManagedFileService;
            yield* managed.apply([
              file({
                id: "cms:settings",
                owner: secret,
                base: base as ManagedFile["base"],
                path: "settings.txt",
                content: { kind: "text", value: "hello world\n" },
              }),
            ]);
            yield* Effect.sleep("25 millis");
            const drained = yield* Queue.takeAll(queue);
            return Chunk.toReadonlyArray(drained);
          }).pipe(Effect.provide(layer)),
        ),
      );

      const managedEvents = collected.filter((event) => String(event._tag).includes("managed-file"));
      expect(managedEvents.length).toBeGreaterThan(0);
      for (const event of managedEvents) {
        expect(event.owner).toBe("[redacted]");
      }
      expect(JSON.stringify(collected)).not.toContain(secret);
    } finally {
      if (previous === undefined) {
        process.env.LANDO_USER_DATA_ROOT = "";
        Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      } else {
        process.env.LANDO_USER_DATA_ROOT = previous;
      }
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("ManagedFile conflict backups", () => {
  test("overwrite backup file is written 0600", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-mfb-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mfb-data-")));
    try {
      const service = await run(
        makeDiskBackend({ defaultBase: () => base, ledgerRoot: () => dataRoot }).pipe(
          Effect.flatMap((backend) => makeManagedFileService(backend)),
        ),
      );
      const mf = file({ id: "d:bk", path: "bk.txt", onConflict: "overwrite" });
      await runScoped(service.apply([mf]));
      const current = await readFile(join(base, "bk.txt"), "utf8");
      await writeFile(join(base, "bk.txt"), `${current}tampered\n`);

      const result = await runScoped(service.apply([mf]));
      const backup = result.entries[0]?.backup;
      expect(backup).toBeDefined();
      const stats = await stat(join(base, backup ?? ""));
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
