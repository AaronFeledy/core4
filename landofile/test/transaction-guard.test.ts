import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import {
  ConfigService,
  LandofileService,
  ManagedFileTransactionGuard,
  StateStore,
} from "@lando/sdk/services";
import { Context, Effect, Either, Layer } from "effect";
import { withResolvedCwd } from "../src/app-resolution.ts";
import { loadLandofileFile, loadLandofileLayers, makeLandofileServiceLive } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const TestStateStoreLive = Layer.succeed(StateStore, makeTestLandofileStateStore());

const withApp = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-guard-load-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const blocked = (root: string) =>
  new ManagedFileTransactionError({
    reason: "blocked",
    phase: "recover",
    path: root,
    cause: "invariant",
    remediation: "Resolve the conflicting target before retrying.",
  });

test("loads repaired layers when the guard changes the file set before enumeration", async () => {
  await withApp(async (root) => {
    // Given: a partial canonical file and a guard that repairs both layers.
    const canonical = join(root, ".lando.yml");
    await writeFile(canonical, "name: [partial\n");
    const roots: string[] = [];
    const transactionGuard = {
      ensureConsistent: (appRoot: string) =>
        Effect.promise(async () => {
          roots.push(appRoot);
          await writeFile(canonical, "name: repaired\n");
          await writeFile(join(root, ".lando.local.yml"), "name: repaired-local\n");
        }),
      pending: () => Effect.succeed(null),
    };

    // When
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        transactionGuard,
      }),
    );

    // Then: the new local layer participates, and the partial YAML was not parsed.
    expect(result.name).toBe("repaired-local");
    expect(roots[0]).toBe(root);
    expect(new Set(roots)).toEqual(new Set([root]));
  });
});

test("preserves the blocked error before reading a missing file set", async () => {
  await withApp(async (root) => {
    // Given
    const failure = blocked(root);

    // When
    const result = await Effect.runPromise(
      loadLandofileLayers(root, join(root, ".lando.yml"), {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        transactionGuard: {
          ensureConsistent: () => Effect.fail(failure),
          pending: () => Effect.succeed(null),
        },
      }).pipe(
        Effect.provideService(ConfigService, {
          load: Effect.die("Global configuration must not be read before the guard"),
          get: () => Effect.die("Global configuration must not be read before the guard"),
        }),
        Effect.either,
      ),
    );

    // Then
    expect(Either.isLeft(result) && result.left).toBe(failure);
  });
});

test("captures the required guard in Live while discover remains context-free", async () => {
  await withApp(async (root) => {
    // Given: the explicit inputs cannot override the required production service.
    await writeFile(join(root, ".lando.yml"), "name: guarded\n");
    const failure = blocked(root);
    const live = makeLandofileServiceLive({
      ports: makeTestLandofilePorts(root),
      templates: { modules: [] },
      transactionGuard: { ensureConsistent: () => Effect.void, pending: () => Effect.succeed(null) },
    }).pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(ManagedFileTransactionGuard, {
            ensureConsistent: () => Effect.fail(failure),
            pending: () => Effect.succeed(null),
          }),
          TestStateStoreLive,
        ),
      ),
    );
    const service = await Effect.runPromise(
      Layer.build(live).pipe(
        Effect.map((context) => Context.get(context, LandofileService)),
        Effect.scoped,
      ),
    );

    // When: no services are provided to discover itself.
    const result = await Effect.runPromise(withResolvedCwd(root, service.discover).pipe(Effect.either));

    // Then: catchAllCause preserves the exact transaction failure.
    expect(Either.isLeft(result) && result.left).toBe(failure);
  });
});

test("allows direct unit callers to omit the guard", async () => {
  await withApp(async (root) => {
    // Given
    const canonical = join(root, ".lando.yml");
    await writeFile(canonical, "name: unit-caller\n");

    // When
    const result = await Effect.runPromise(loadLandofileLayers(root, canonical));

    // Then
    expect(result.name).toBe("unit-caller");
  });
});

test("consults a context guard when callers omit transactionGuard inputs", async () => {
  await withApp(async (root) => {
    // Given: a readable Landofile and a blocked journal represented only in context.
    const canonical = join(root, ".lando.yml");
    await writeFile(canonical, "name: unguarded\n");
    const failure = blocked(root);

    // When: production wrappers pass composition inputs with no transactionGuard field.
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
      }).pipe(
        Effect.provideService(ManagedFileTransactionGuard, {
          ensureConsistent: () => Effect.fail(failure),
          pending: () => Effect.succeed(null),
        }),
        Effect.either,
      ),
    );

    // Then
    expect(Either.isLeft(result) && result.left).toBe(failure);
  });
});

test("consults a context guard before reading a single Landofile file", async () => {
  await withApp(async (root) => {
    // Given
    const canonical = join(root, ".lando.yml");
    await writeFile(canonical, "name: unguarded\n");
    const failure = blocked(root);

    // When
    const result = await Effect.runPromise(
      loadLandofileFile(canonical).pipe(
        Effect.provideService(ManagedFileTransactionGuard, {
          ensureConsistent: () => Effect.fail(failure),
          pending: () => Effect.succeed(null),
        }),
        Effect.either,
      ),
    );

    // Then
    expect(Either.isLeft(result) && result.left).toBe(failure);
  });
});

test("recovers the cwd file set before walking to a parent Landofile", async () => {
  await withApp(async (root) => {
    // Given: cwd has no Landofile yet, but a parent does, and recovery would create cwd's file.
    const child = join(root, "app");
    await mkdir(child);
    await writeFile(join(root, ".lando.yml"), "name: parent\n");
    const roots: string[] = [];
    const live = makeLandofileServiceLive({
      ports: makeTestLandofilePorts(child),
      templates: { modules: [] },
    }).pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(ManagedFileTransactionGuard, {
            ensureConsistent: (appRoot: string) =>
              Effect.promise(async () => {
                roots.push(appRoot);
                if (appRoot === child) await writeFile(join(child, ".lando.yml"), "name: child\n");
              }),
            pending: () => Effect.succeed(null),
          }),
          TestStateStoreLive,
        ),
      ),
    );
    const service = await Effect.runPromise(
      Layer.build(live).pipe(
        Effect.map((context) => Context.get(context, LandofileService)),
        Effect.scoped,
      ),
    );

    // When
    const result = await Effect.runPromise(withResolvedCwd(child, service.discover));

    // Then: recovery at cwd is consulted first and the parent file is not consumed.
    expect(result.name).toBe("child");
    expect(roots[0]).toBe(child);
  });
});
