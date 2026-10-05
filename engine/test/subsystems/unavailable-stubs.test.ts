import { expect, test } from "bun:test";
import { CaError, HealthcheckError, ProxyApplyError } from "@lando/sdk/errors";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { CertificateAuthority, HealthcheckRunner, RouterService } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import * as Certs from "../../src/subsystems/certs/api.ts";
import * as Healthcheck from "../../src/subsystems/healthcheck/api.ts";
import * as Router from "../../src/subsystems/proxy/api.ts";
import { nonePlan } from "./healthcheck/support.ts";

test.each(["first-app", "second-app"])("unavailable route application retains app id %s", async (id) => {
  const result = await Effect.runPromise(
    Effect.flatMap(RouterService, (router) => router.applyRoutes([], AppId.make(id))).pipe(
      Effect.provide(Router.layerUnavailable),
      Effect.result,
    ),
  );
  expect(result).toEqual(
    Result.fail(
      new ProxyApplyError({
        message:
          "RouterService is not selected. Install and select the bundled Traefik router plugin, then run `lando setup` to provision the global app.",
        proxyId: "unavailable",
        app: id,
        remediation: "Install and select a RouterService plugin, then retry route application.",
      }),
    ),
  );
});

test.each(["web", "database"])("unavailable healthcheck retains service %s", async (service) => {
  const result = await Effect.runPromise(
    Effect.flatMap(HealthcheckRunner, (runner) =>
      runner.run(nonePlan(), AppId.make("test-app"), ServiceName.make(service)),
    ).pipe(Effect.provide(Healthcheck.layerUnavailable), Effect.result),
  );
  expect(result).toEqual(
    Result.fail(
      new HealthcheckError({
        message:
          "HealthcheckRunner requires provider-exec. Run `lando setup` to install the provider (full implementation is not available yet).",
        service,
      }),
    ),
  );
});

test("unavailable certificates preserve setup and issuance errors", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ca = yield* CertificateAuthority;
      return {
        id: ca.id,
        setup: yield* ca.setup({ force: false }).pipe(Effect.result),
        issue: yield* ca.issueCert({ cn: "test", sans: ["test"] }).pipe(Effect.result),
      };
    }).pipe(Effect.provide(Certs.layerUnavailable)),
  );
  const failure = Result.fail(
    new CaError({
      message:
        "CertificateAuthority requires @lando/ca-mkcert. Run `lando setup` to install the CA (full implementation is not available yet).",
      caId: "unavailable",
    }),
  );
  expect(result).toEqual({ id: "unavailable", setup: failure, issue: failure });
});
