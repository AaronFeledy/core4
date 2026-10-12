import { expect, test } from "bun:test";
import { Effect } from "effect";

import { app, httpsRoutes, makeHarness } from "./proxy-tls-harness.ts";

test("hydrates persisted ports and default domain when a fresh router applies routes without setup", async () => {
  // Given: only the shared filesystem carries the previous setup's router configuration.
  const harness = makeHarness();
  await Effect.runPromise(
    Effect.scoped(
      harness.service.setup({
        defaultDomain: "Custom.Test.",
        router: { httpPort: 46080, httpsPort: 46443 },
      }),
    ),
  );
  const fresh = harness.makeService();

  // When: a new process applies routes without setup or prepare.
  const applied = await Effect.runPromise(fresh.applyRoutes(httpsRoutes, app));

  // Then: authorities and default TLS material retain the persisted configuration.
  expect(applied.authorities.map(({ port }) => port)).toEqual([46443, 46080, 46443]);
  expect(harness.calls.find((spec) => spec.cn.startsWith("*."))).toEqual({
    cn: "*.custom.test",
    sans: ["*.custom.test", "custom.test", "traefik.lndo.site"],
  });
  expect(harness.files.get("/lando/global/proxy-traefik/dynamic/tls-default.yml")).toContain(
    "/etc/traefik/dynamic/certs/default-custom.test.crt",
  );
});

test("uses default ports and domain when a fresh router has no persisted state", async () => {
  // Given: no setup has persisted router state.
  const harness = makeHarness();

  // When: routes are applied directly.
  const applied = await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

  // Then: the default authorities and wildcard certificate are used.
  expect(applied.authorities.map(({ port }) => port)).toEqual([38443, 38080, 38443]);
  expect(harness.calls.find((spec) => spec.cn.startsWith("*."))?.cn).toBe("*.lndo.site");
});

test("refreshes retained authorities and default TLS when another router completes setup", async () => {
  // Given: a retained router has already published the old configuration.
  const harness = makeHarness();
  await Effect.runPromise(
    Effect.scoped(
      harness.service.setup({
        defaultDomain: "old.test",
        router: { httpPort: 46080, httpsPort: 46443 },
      }),
    ),
  );
  await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));
  await Effect.runPromise(
    Effect.scoped(
      harness.makeService().setup({
        defaultDomain: "New.Test.",
        router: { httpPort: 47080, httpsPort: 47443 },
      }),
    ),
  );

  // When: the retained router publishes again without running setup itself.
  const applied = await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

  // Then: publication uses the other router's durable ports and normalized domain.
  expect(applied.authorities.map(({ port }) => port)).toEqual([47443, 47080, 47443]);
  expect(harness.calls.filter((spec) => spec.cn.startsWith("*.")).map((spec) => spec.cn)).toEqual([
    "*.old.test",
    "*.new.test",
  ]);
  expect(harness.files.get("/lando/global/proxy-traefik/dynamic/tls-default.yml")).toContain(
    "/etc/traefik/dynamic/certs/default-new.test.crt",
  );
});

test("preserves the established domain and publication when setup fails pin validation", async () => {
  // Given: successful setup established a domain and an advertised port pair.
  const harness = makeHarness();
  await Effect.runPromise(
    Effect.scoped(
      harness.service.setup({
        defaultDomain: "accepted.test",
        router: { httpPort: 46080, httpsPort: 46443 },
      }),
    ),
  );

  // When: setup on that instance rejects a different pinned pair and domain.
  const result = await Effect.runPromise(
    Effect.scoped(
      harness.service.setup({
        defaultDomain: "rejected.test",
        routerPin: { httpPort: 47080, httpsPort: 47443 },
      }),
    ).pipe(Effect.result),
  );

  // Then: neither retained nor fresh publication adopts the rejected domain.
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "RouterPortPinMismatch" } });
  expect(harness.files.get("/lando/global/proxy-traefik/dynamic/.lando-default-domain")).toBe(
    "accepted.test\n",
  );
  await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));
  await Effect.runPromise(harness.makeService().applyRoutes(httpsRoutes, app));
  expect(harness.calls.filter((spec) => spec.cn.startsWith("*.")).map((spec) => spec.cn)).toEqual([
    "*.accepted.test",
    "*.accepted.test",
  ]);
  expect(harness.files.get("/lando/global/proxy-traefik/dynamic/tls-default.yml")).toContain(
    "/etc/traefik/dynamic/certs/default-accepted.test.crt",
  );
});

test("removes the persisted default domain when the router stops", async () => {
  // Given: setup persisted a custom default domain.
  const harness = makeHarness();
  await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "Custom.Test." })));

  // When: the router stops.
  await Effect.runPromise(harness.service.stop);

  // Then: stop removes the domain state alongside the other router state.
  expect(harness.operations).toContain("remove:/lando/global/proxy-traefik/dynamic/.lando-default-domain");
  expect(harness.files.has("/lando/global/proxy-traefik/dynamic/.lando-default-domain")).toBe(false);
});

test("falls back to defaults when persisted acquisition state is corrupt and the domain is empty", async () => {
  // Given: neither persisted value can establish usable router state.
  const harness = makeHarness();
  harness.files.set("/lando/global/proxy-traefik/dynamic/.lando-port-acquisition.json", "invalid json");
  harness.files.set("/lando/global/proxy-traefik/dynamic/.lando-default-domain", " \n...\n");

  // When: a fresh router applies routes without setup.
  const applied = await Effect.runPromise(harness.makeService().applyRoutes(httpsRoutes, app));

  // Then: hydration does not fail and uses the default authorities and domain.
  expect(applied.authorities.map(({ port }) => port)).toEqual([38443, 38080, 38443]);
  expect(harness.calls.find((spec) => spec.cn.startsWith("*."))?.cn).toBe("*.lndo.site");
});

test("reissues default TLS material when the normalized default domain changes", async () => {
  // Given: default TLS material issued for the initial configured domain.
  const harness = makeHarness();
  await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "Lndo.Site." })));
  await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

  // When: proxy setup and route application switch to a second domain.
  await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "Other.Test." })));
  await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

  // Then: a second default certificate is issued and the durable store references its keyed paths.
  const defaultCertificates = harness.calls.filter((spec) => spec.cn.startsWith("*."));
  expect(defaultCertificates.map((spec) => spec.cn)).toEqual(["*.lndo.site", "*.other.test"]);
  expect(defaultCertificates.at(-1)?.sans).toEqual(["*.other.test", "other.test", "traefik.lndo.site"]);
  expect(
    Bun.YAML.parse(harness.files.get("/lando/global/proxy-traefik/dynamic/tls-default.yml") ?? ""),
  ).toEqual({
    tls: {
      stores: {
        default: {
          defaultCertificate: {
            certFile: "/etc/traefik/dynamic/certs/default-other.test.crt",
            keyFile: "/etc/traefik/dynamic/certs/default-other.test.key",
          },
        },
      },
    },
  });
});
