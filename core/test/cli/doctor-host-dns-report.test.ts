import { expect, test } from "bun:test";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns";
import { collectRuntimeDoctor as doctorReport } from "./doctor-report-fixture";

test.each([
  { addresses: ["127.0.0.1"], status: "pass" },
  { addresses: ["192.0.2.1"], status: "warn" },
  { addresses: [], status: "warn" },
])(
  "library report inspects host DNS without runtime subsystems: $addresses",
  async ({ addresses, status }) => {
    // Given a library runtime with a resolver but no router or SSH service.
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    const hostnames: string[] = [];
    // When the public report collects diagnostics.
    const report = await Effect.runPromise(
      doctorReport({ env: {}, platform: "darwin" }).pipe(
        Effect.provide(PluginRegistryLayer.layer),
        Effect.provideService(
          ConfigService,
          ConfigService.of({
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
        ),
        Effect.provideService(PathsService, makeLandoPaths({ env: process.env })),
        Effect.provideService(
          RuntimeProviderRegistry,
          makeTestRuntimeProviderRegistry({
            list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
          }),
        ),
        Effect.provideService(
          HostDnsResolver,
          HostDnsResolver.of({
            lookup: (hostname) =>
              Effect.sync(() => {
                hostnames.push(hostname);
                return addresses;
              }),
          }),
        ),
      ),
    );
    // Then the injected resolver determines the verdict without invented service status.
    expect(hostnames).toEqual(["lando-doctor-probe.lndo.site"]);
    const check = report.checks
      .filter((check) => check.section === "subsystems")
      .find((entry) => entry.name === "host-dns");
    expect(check).toMatchObject({ status, context: { dnsResolved: String(status === "pass") } });
    for (const key of ["active", "mode", "mechanism", "subsystemId"]) {
      expect(check?.context).not.toHaveProperty(key);
    }
    expect(report.skipped.some((entry) => entry.check === "host-dns")).toBe(false);
    if (status === "warn") expect(check?.solutions[0]?.description).toContain("DNS-rebinding protection");
  },
);
