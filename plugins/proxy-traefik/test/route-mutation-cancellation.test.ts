import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { appCertificateFiles, routeFile } from "../src/proxy-paths.ts";
import { removeAppCertificates } from "../src/tls.ts";
import { app } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";
import { routeMetadataLine } from "./route-owner-fixture.ts";
import { DAY_MS, expiry, makeCertificateFixture, pem, route } from "./router-certificate-fixture.ts";

for (const operation of ["empty-routes", "remove-routes", "certificate", "private-key"] as const) {
  test(`cancellation joins an in-flight ${operation} unlink before releasing its caller`, async () => {
    const fixture = makeAcceptanceFixture();
    const certificates = appCertificateFiles(fixture.dependencies.paths, app);
    const target =
      operation === "certificate"
        ? certificates.cert
        : operation === "private-key"
          ? certificates.key
          : routeFile(fixture.dependencies.paths, app);
    fixture.files.set(
      target,
      operation === "certificate" || operation === "private-key"
        ? "previous publication"
        : `${routeMetadataLine(app)}\nprevious publication`,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let callerReleased = false;
    const dependencies = {
      ...fixture.dependencies,
      fileSystem: {
        ...fixture.dependencies.fileSystem,
        remove: (path: string) =>
          path === target
            ? Effect.tryPromise(async () => {
                entered.resolve();
                await release.promise;
                fixture.files.delete(path);
              })
            : fixture.dependencies.fileSystem.remove(path),
      },
    };
    const router = makeTraefikRouterService(dependencies);
    const mutation =
      operation === "empty-routes"
        ? router.applyRoutes([], app)
        : operation === "remove-routes"
          ? router.removeRoutes(app)
          : removeAppCertificates(dependencies, app);
    const fiber = Effect.runFork(
      mutation.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            callerReleased = true;
          }),
        ),
      ),
    );
    await entered.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    try {
      await Effect.runPromise(Effect.yieldNow);
      expect(callerReleased).toBe(false);
      expect(fixture.files.has(target)).toBe(true);
    } finally {
      release.resolve();
      await interrupted;
    }
    expect(callerReleased).toBe(true);
    expect(fixture.files.has(target)).toBe(false);
  });
}

test.each(["default", "app"] as const)(
  "cancellation joins the complete TLS publication after the %s key write starts",
  async (target) => {
    const f = makeCertificateFixture("win32");
    f.seed(pem.expiring);
    const key = target === "app" ? f.appFiles.key : f.defaultFiles.key;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = makeTraefikRouterService({
      ...f.dependencies,
      fileSystem: {
        ...f.dependencies.fileSystem,
        writeSecretAtomic: (path, content) =>
          path === key
            ? Effect.tryPromise(async () => {
                entered.resolve();
                await release.promise;
              }).pipe(Effect.andThen(f.dependencies.fileSystem.writeSecretAtomic(path, content)))
            : f.dependencies.fileSystem.writeSecretAtomic(path, content),
      },
    });
    const applying = f.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(service.applyRoutes([route], app));
        yield* Effect.promise(() => entered.promise);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        yield* Effect.sync(() => release.resolve());
        yield* Fiber.join(interruption);
      }),
      expiry + DAY_MS,
    );
    await applying;

    expect(f.files.get(f.appFiles.cert)).toBe(pem.current.certificate);
    expect(f.files.get(f.appFiles.key)).toBe(pem.current.privateKey);
    expect(f.files.get(f.defaultFiles.cert)).toBe(pem.current.certificate);
    expect(f.files.get(f.defaultFiles.key)).toBe(pem.current.privateKey);
    expect(f.operations.at(-1)).toBe(`write:${f.watched}`);
    expect(f.events).not.toContain("ack:set");
  },
);
