import { expect, test } from "bun:test";
import type { TlsPeerInput } from "@lando/http-client/tls-peer";
import { LEAF_RENEWAL_MARGIN_MS, certificatePairIsCurrent } from "@lando/sdk/certificates";
import { CertificateName } from "@lando/sdk/schema";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { app } from "./proxy-tls-harness.ts";
import { routeOwner } from "./route-owner-fixture.ts";
import { domain, makeCertificateFixture, now, pem, route } from "./router-certificate-fixture.ts";

for (const platform of ["linux", "win32", "darwin", "wsl"] as const) {
  test(`serializes shared default pair publication across router instances on ${platform}`, async () => {
    const fixture = makeCertificateFixture(platform);
    fixture.seed(pem.expiring);
    const ownerB = routeOwner("other-owner");
    await fixture.run(
      Effect.gen(function* () {
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const requested = yield* Deferred.make<void>();
        let hold = true;
        const dependencies = {
          ...fixture.dependencies,
          observeTlsPeer: () => Effect.succeed(pem.current.certificate),
          fileSystem: {
            ...fixture.dependencies.fileSystem,
            writeSecretAtomic: (path: string, content: string | Uint8Array) =>
              fixture.dependencies.fileSystem.writeSecretAtomic(path, content).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (path !== fixture.defaultFiles.key || !hold) return;
                    hold = false;
                    yield* Deferred.succeed(paused, undefined);
                    yield* Deferred.await(resume);
                  }),
                ),
              ),
          },
        };
        const a = yield* Effect.forkChild(makeTraefikRouterService(dependencies).applyRoutes([route], app));
        yield* Deferred.await(paused);
        fixture.state.issued = pem.rotated;
        const bDependencies = {
          ...dependencies,
          certificateAuthority: {
            ...dependencies.certificateAuthority,
            issueCert: (spec: Parameters<typeof dependencies.certificateAuthority.issueCert>[0]) =>
              dependencies.certificateAuthority.issueCert(spec).pipe(
                Effect.map((issued) => ({
                  ...issued,
                  root: { certificate: pem.rootB, trusted: true },
                })),
              ),
          },
          observeTlsPeer: ({ hostname, caPems }: TlsPeerInput) =>
            Effect.succeed(
              caPems.length === 1 || hostname === `test.${domain}`
                ? pem.rotated.certificate
                : pem.current.certificate,
            ),
          stateStore: {
            ...dependencies.stateStore,
            withLock: ((key, body, options) =>
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(dependencies.stateStore.withLock(key, body, options)),
              )) satisfies typeof dependencies.stateStore.withLock,
          },
        };
        const b = yield* Effect.forkChild(
          makeTraefikRouterService(bDependencies).applyRoutes(
            [{ ...route, hostname: `test.${domain}` }],
            ownerB,
          ),
        );
        // The second fiber has reached the shared lock; yielding lets an unlocked apply finish.
        yield* Effect.race(Deferred.await(requested), Fiber.join(b));
        yield* Effect.yieldNow;
        const callsWhilePaused = fixture.calls.length;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        expect(
          certificatePairIsCurrent(
            {
              certificate: fixture.files.get(fixture.defaultFiles.cert) ?? "",
              privateKey: fixture.files.get(fixture.defaultFiles.key) ?? "",
            },
            {
              names: [CertificateName.make(`*.${domain}`)],
              root: pem.rootA,
              now,
              renewalMarginMs: LEAF_RENEWAL_MARGIN_MS,
            },
          ),
        ).toBe(true);
        expect(callsWhilePaused).toBe(2);
        expect(fixture.calls.filter((spec) => spec.cn === `*.${domain}`)).toHaveLength(1);
      }),
      Date.parse("2026-12-15T00:00:00Z"),
    );
  });
}

for (const platform of ["linux", "win32", "darwin", "wsl"] as const) {
  test(`releases the mutation lock after a failed pair write on ${platform}`, async () => {
    const f = makeCertificateFixture(platform);
    f.seed(pem.expiring);
    const service = makeTraefikRouterService({
      ...f.dependencies,
      fileSystem: {
        ...f.dependencies.fileSystem,
        writeAtomic: (path, content) =>
          path === f.defaultFiles.cert
            ? Effect.fail("injected publication failure")
            : f.dependencies.fileSystem.writeAtomic(path, content),
      },
    });
    const result = await f.run(
      service.applyRoutes([route], app).pipe(Effect.result),
      Date.parse("2026-12-15T00:00:00Z"),
    );
    expect(result._tag).toBe("Failure");
    await f.run(f.makeService().applyRoutes([route], app), Date.parse("2026-12-15T00:00:00Z"));
    expect(f.files.get(f.defaultFiles.cert)).toBe(pem.current.certificate);
    expect(f.files.get(f.defaultFiles.key)).toBe(pem.current.privateKey);
  });

  test(`releases the mutation lock when served acceptance is canceled on ${platform}`, async () => {
    const f = makeCertificateFixture(platform);
    f.seed(pem.current);
    const entered = Deferred.makeUnsafe<void>();
    const service = makeTraefikRouterService({
      ...f.dependencies,
      observeTlsPeer: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    await f.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(service.applyRoutes([route], app));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        yield* f.makeService().applyRoutes([route], app);
      }),
    );
    expect(f.calls).toEqual([]);
  });
}
