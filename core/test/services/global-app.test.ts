import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { GlobalDistConflictError, GlobalLandofilePathConflictError } from "@lando/core/errors";
import { LandofileShape } from "@lando/core/schema";
import { GlobalAppService } from "@lando/core/services";

import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const globalAppLayer = GlobalAppServiceLive.pipe(
  Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive)),
);

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-app-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-app-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: process.env delete is required so Bun does not coerce undefined to the string "undefined".
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: process.env delete is required so Bun does not coerce undefined to the string "undefined".
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const parseGeneratedLandofile = (content: string) =>
  Effect.runPromise(parseLandofile({ file: ".lando.dist.yml", content, cwd: "/tmp" }));

describe("GlobalAppServiceLive", () => {
  test("exposes the reserved global id", async () => {
    const id = await Effect.runPromise(
      Effect.map(GlobalAppService, (service) => service.id).pipe(Effect.provide(globalAppLayer)),
    );

    expect(id).toBe("global");
  });

  test("resolves the global app root under the user data root", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.root).pipe(Effect.provide(globalAppLayer)),
      );

      expect(root).toBe(join(dataRoot, "global"));
    });
  });

  test("ensureRoot creates the global app directory idempotently", async () => {
    await withTempRoots(async (dataRoot) => {
      const expectedRoot = join(dataRoot, "global");

      const ensure = Effect.scoped(Effect.flatMap(GlobalAppService, (service) => service.ensureRoot)).pipe(
        Effect.provide(globalAppLayer),
      );

      await Effect.runPromise(ensure);
      expect((await stat(expectedRoot)).isDirectory()).toBe(true);

      await Effect.runPromise(ensure);
      expect((await stat(expectedRoot)).isDirectory()).toBe(true);
    });
  });

  test("regenerateDist creates a parser-valid dist file and reruns unchanged", async () => {
    await withTempRoots(async () => {
      const first = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.regenerateDist()).pipe(
          Effect.provide(globalAppLayer),
        ),
      );
      const firstContent = await readFile(first.path, "utf8");
      const parsed = await parseGeneratedLandofile(firstContent);

      expect(first.status).toBe("created");
      expect(first.serviceIds).toEqual([]);
      expect(parsed).toEqual({ name: "global", runtime: 4, services: {} });
      expect(Schema.decodeUnknownSync(LandofileShape)(parsed).name).toBe("global");

      const second = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.regenerateDist()).pipe(
          Effect.provide(globalAppLayer),
        ),
      );

      expect(second.status).toBe("unchanged");
      expect(await readFile(second.path, "utf8")).toBe(firstContent);
    });
  });

  test("regenerateDist rejects a foreign dist file with tagged remediation", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = join(dataRoot, "global");
      const distPath = join(root, ".lando.dist.yml");
      await mkdir(root, { recursive: true });
      await writeFile(distPath, "name: someone-else\n");

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(GlobalAppService, (service) => service.regenerateDist()).pipe(
          Effect.provide(globalAppLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(GlobalDistConflictError);
          if (failure.value instanceof GlobalDistConflictError) {
            expect(failure.value.reason).toBe("foreign-file");
            expect(failure.value.path).toBe(distPath);
            expect(failure.value.remediation).toContain(".lando.dist.yml");
          }
        }
      }
    });
  });

  test("regenerateDist rejects manual edits to the generated body", async () => {
    await withTempRoots(async () => {
      const created = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.regenerateDist()).pipe(
          Effect.provide(globalAppLayer),
        ),
      );
      await writeFile(
        created.path,
        (await readFile(created.path, "utf8")).replace("runtime: 4", "runtime: 4\nrecipe: hacked"),
      );

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(GlobalAppService, (service) => service.regenerateDist()).pipe(
          Effect.provide(globalAppLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(GlobalDistConflictError);
          if (failure.value instanceof GlobalDistConflictError) {
            expect(failure.value.reason).toBe("manual-edit");
            expect(failure.value.remediation).toContain("move changes");
          }
        }
      }
    });
  });

  test("regenerateDist emits service contributions that parse and validate", async () => {
    await withTempRoots(async () => {
      const result = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) =>
          service.regenerateDist({
            services: {
              traefik: {
                image: "traefik:v3",
                ports: ["80:80", "443:443"],
                environment: { LANDO_GLOBAL: "true" },
              },
            },
          }),
        ).pipe(Effect.provide(globalAppLayer)),
      );
      const parsed = (await parseGeneratedLandofile(await readFile(result.path, "utf8"))) as Record<
        string,
        unknown
      >;
      const services = parsed.services as Record<
        string,
        { readonly image?: string; readonly ports?: ReadonlyArray<string> }
      >;

      expect(result.serviceIds).toEqual(["traefik"]);
      expect(services.traefik?.image).toBe("traefik:v3");
      expect(services.traefik?.ports).toEqual(["80:80", "443:443"]);
      expect(Schema.decodeUnknownSync(LandofileShape)(parsed).runtime).toBe(4);
    });
  });

  test("regenerateDist materializes bind-mount sources for string-form mounts", async () => {
    await withTempRoots(async (dataRoot) => {
      // Given a global service authoring a Traefik dynamic-config string-form mount
      const result = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) =>
          service.regenerateDist({
            services: {
              traefik: {
                image: "traefik:v3",
                mounts: ["./proxy-traefik/dynamic:/etc/traefik/dynamic:ro"],
              },
            },
          }),
        ).pipe(Effect.provide(globalAppLayer)),
      );

      // Then the string-form bind source is created under the global root
      expect(result.serviceIds).toEqual(["traefik"]);
      const sourceDir = join(dataRoot, "global", "proxy-traefik", "dynamic");
      expect((await stat(sourceDir)).isDirectory()).toBe(true);
    });
  });

  test("ensureUserLandofile creates a comment-only overlay once and preserves edits", async () => {
    await withTempRoots(async () => {
      const first = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.ensureUserLandofile).pipe(
          Effect.provide(globalAppLayer),
        ),
      );
      const initialContent = await readFile(first.path, "utf8");
      const parsed = await parseGeneratedLandofile(initialContent);

      expect(first.created).toBe(true);
      expect(parsed).toEqual({});

      const edited = `${initialContent}\nname: customized-global\n`;
      await writeFile(first.path, edited);

      const second = await Effect.runPromise(
        Effect.flatMap(GlobalAppService, (service) => service.ensureUserLandofile).pipe(
          Effect.provide(globalAppLayer),
        ),
      );

      expect(second.created).toBe(false);
      expect(await readFile(first.path, "utf8")).toBe(edited);
    });
  });

  test("ensureUserLandofile rejects a directory at .lando.yml", async () => {
    await withTempRoots(async (dataRoot) => {
      const userPath = join(dataRoot, "global", ".lando.yml");
      await mkdir(userPath, { recursive: true });

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(GlobalAppService, (service) => service.ensureUserLandofile).pipe(
          Effect.provide(globalAppLayer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(GlobalLandofilePathConflictError);
          if (failure.value instanceof GlobalLandofilePathConflictError) {
            expect(failure.value.expected).toBe("file");
            expect(failure.value.actual).toBe("directory");
            expect(failure.value.path).toBe(userPath);
          }
        }
      }
    });
  });
});
