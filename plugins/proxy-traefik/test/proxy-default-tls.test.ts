import { expect, test } from "bun:test";
import { Effect } from "effect";

import { app, httpsRoutes, makeHarness } from "./proxy-tls-harness.ts";

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
