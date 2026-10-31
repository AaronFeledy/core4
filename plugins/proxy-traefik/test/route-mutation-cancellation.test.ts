import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { appCertificateFiles, routeFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { removeAppCertificates } from "../src/tls.ts";
import { app } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

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
    fixture.files.set(target, "previous publication");
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
