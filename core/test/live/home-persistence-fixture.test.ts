import { expect, test } from "bun:test";
import { mvpProviderCapabilities } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { selectCatalogHomes } from "./home-persistence-fixture.ts";

for (const platform of ["linux", "darwin", "win32"] as const) {
  for (const [provider, capabilities] of [
    ["lando", mvpProviderCapabilities(platform)],
    ["podman", podmanCapabilitiesForPlatform(platform)],
  ] as const) {
    for (const arch of ["x64", "amd64", "x86_64", "arm64", "aarch64"]) {
      test(`home fixture selects applicable catalog cases for ${provider}/${platform}/${arch}`, () => {
        const { supported, excluded } = selectCatalogHomes(arch, capabilities);
        const amd64 = ["x64", "amd64", "x86_64"].includes(arch);
        expect(supported.map(([type]) => type)).toEqual([
          ...(amd64 ? (["mssql", "mssql:2019", "mssql:2022"] as const) : []),
          "solr",
          "solr:9",
          "varnish",
          "varnish:6",
          "varnish:7",
        ]);
        expect(excluded.map(([type]) => type)).toEqual(amd64 ? [] : ["mssql", "mssql:2019", "mssql:2022"]);
      });
    }
  }
}

test("home fixture retains MSSQL when the provider supports architecture emulation", () => {
  expect(selectCatalogHomes("arm64", { architectureEmulation: true }).supported).toHaveLength(8);
  expect(selectCatalogHomes("arm64", { architectureEmulation: true }).excluded).toEqual([]);
});

for (const [hostArch, providerArch] of [
  ["x64", "arm64"],
  ["arm64", "x64"],
  ["x64", "unknown"],
] as const) {
  test(`home fixture excludes only MSSQL for host ${hostArch} and provider ${providerArch}`, () => {
    const { supported, excluded } = selectCatalogHomes(
      hostArch,
      { architectureEmulation: false },
      providerArch,
    );
    expect(supported.map(([type]) => type)).toEqual(["solr", "solr:9", "varnish", "varnish:6", "varnish:7"]);
    expect(excluded.map(([type]) => type)).toEqual(["mssql", "mssql:2019", "mssql:2022"]);
  });
}
