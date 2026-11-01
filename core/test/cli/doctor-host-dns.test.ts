import { expect, test } from "bun:test";
import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns.ts";
import { subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";
import { DefaultSubsystemDoctorLayer } from "./doctor-subsystem-fixture.ts";

test.each([
  { addresses: ["127.0.0.1"], status: "pass" },
  { addresses: ["192.0.2.1"], status: "warn" },
  { addresses: [], status: "warn" },
  { addresses: ["127.0.0.1", "192.0.2.1"], status: "warn" },
])("inspects host DNS with only a resolver: $addresses", async ({ addresses, status }) => {
  // Given only a host DNS resolver.
  const resolver = HostDnsResolver.of({ lookup: () => Effect.succeed(addresses) });
  // When doctor inspects the host.
  const result = await Effect.runPromise(
    subsystemDoctor().pipe(Effect.provideService(HostDnsResolver, resolver)),
  );
  // Then the verdict reflects DNS alone, without fabricated service status.
  const check = result.checks.find((entry) => entry.name === "host-dns");
  expect(check).toMatchObject({
    status,
    context: {
      baseDomain: "lndo.site",
      dnsHostname: "lando-doctor-probe.lndo.site",
      dnsResolved: String(status === "pass"),
      ...(addresses.length === 0 ? {} : { dnsAddresses: addresses.join(",") }),
      loopback: "127.0.0.1",
    },
  });
  for (const key of [
    "active",
    "mode",
    "mechanism",
    "subsystemId",
    ...(addresses.length === 0 ? ["dnsAddresses"] : []),
  ]) {
    expect(check?.context).not.toHaveProperty(key);
  }
  expect(result.skipped?.some((entry) => entry.section === "host-dns")).toBe(false);
  if (status === "warn") {
    expect(check?.solutions[0]?.description).toContain("DNS-rebinding protection");
    expect(check?.solutions[0]?.description).toContain("Add a local DNS rule");
  }
});

test("skips host DNS when no resolver is provided", async () => {
  // Given no host services or resolver.
  // When doctor inspects the available context.
  const result = await Effect.runPromise(subsystemDoctor());
  // Then it explains the missing inspection capability.
  expect(result.checks.some((entry) => entry.name === "host-dns")).toBe(false);
  expect(result.skipped).toContainEqual({
    section: "host-dns",
    status: "skipped",
    reason: "Host DNS resolver was not provided; no host DNS inspection was performed.",
  });
});

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
    const check = result.checks.find((entry) => entry.name === "host-dns");
    expect(check).toMatchObject({
      status: "warn",
      recovery: "manual",
      context: { baseDomain: "lndo.test", dnsHostname: "lando-doctor-probe.lndo.test", dnsResolved: "false" },
    });
    expect(check?.solutions[0]?.command).toBeUndefined();
  },
);

test("does not run host DNS checks when config construction fails", async () => {
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
