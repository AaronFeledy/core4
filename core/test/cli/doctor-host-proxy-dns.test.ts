import { expect, test } from "bun:test";
import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns.ts";
import { subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";
import { DefaultSubsystemDoctorLayer } from "./doctor-subsystem-fixture.ts";

test.each(["lndo.test", "LNDO.Test"])(
  "warns for an unresolved configured domain %s even when the default domain resolves",
  async (defaultDomain) => {
    // Given
    const config = Schema.decodeUnknownSync(GlobalConfig)({ proxy: { defaultDomain } });
    const hostnames: string[] = [];
    const resolver = HostDnsResolver.of({
      lookup: (hostname) =>
        Effect.sync(() => {
          hostnames.push(hostname);
          return hostname === "lando-doctor-probe.lndo.site" ? ["127.0.0.1"] : [];
        }),
    });

    // When
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(
        Effect.provideService(
          ConfigService,
          ConfigService.of({
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
        ),
        Effect.provideService(HostDnsResolver, resolver),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );

    // Then
    expect(hostnames).toEqual(["lando-doctor-probe.lndo.test"]);
    const check = result.checks.find((entry) => entry.name === "host-proxy");
    expect(check).toMatchObject({
      status: "warn",
      recovery: "manual",
      context: { baseDomain: "lndo.test", dnsHostname: "lando-doctor-probe.lndo.test", dnsResolved: "false" },
    });
    expect(check?.solutions[0]?.command).toBeUndefined();
  },
);

test("does not run host-proxy checks when config construction fails", async () => {
  // Given
  const failure = new ConfigError({
    message: "config unavailable",
    path: "/config.yml",
    remediation: "Restore /config.yml for the doctor fixture.",
  });
  const config = Layer.effect(ConfigService, Effect.fail(failure));

  // When
  const result = await Effect.runPromise(
    subsystemDoctor()
      .pipe(
        Effect.provide(config),
        Effect.provideService(
          HostDnsResolver,
          HostDnsResolver.of({ lookup: () => Effect.succeed(["127.0.0.1"]) }),
        ),
        Effect.provide(DefaultSubsystemDoctorLayer),
      )
      .pipe(Effect.result),
  );

  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure });
});
