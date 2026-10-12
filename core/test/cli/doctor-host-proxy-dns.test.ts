import { expect, test } from "bun:test";
import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";

test.each(["lndo.test", "  LNDO.TEST...  "])(
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

test("falls back to the default domain when config reads fail", async () => {
  // Given
  const failure = new ConfigError({ message: "config unavailable", path: "/config.yml" });
  const config = ConfigService.of({
    load: Effect.fail(failure),
    get: () => Effect.fail(failure),
  });

  // When
  const result = await Effect.runPromise(
    subsystemDoctor().pipe(
      Effect.provideService(ConfigService, config),
      Effect.provideService(
        HostDnsResolver,
        HostDnsResolver.of({ lookup: () => Effect.succeed(["127.0.0.1"]) }),
      ),
      Effect.provide(DefaultSubsystemDoctorLayer),
    ),
  );

  // Then
  expect(result.checks.find((entry) => entry.name === "host-proxy")).toMatchObject({
    status: "pass",
    context: { baseDomain: "lndo.site", dnsHostname: "lando-doctor-probe.lndo.site" },
  });
});
