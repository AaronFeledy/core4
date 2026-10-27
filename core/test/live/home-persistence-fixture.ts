import type { ProviderCapabilities } from "@lando/sdk/schema";

const catalogHomes = [
  ["mssql", "mssql", "/home/mssql"],
  ["mssql:2019", "mssql", "/home/mssql"],
  ["mssql:2022", "mssql", "/home/mssql"],
  ["solr", "solr", "/home/solr"],
  ["solr:9", "solr", "/home/solr"],
  ["varnish", "root", "/root"],
  ["varnish:6", "root", "/root"],
  ["varnish:7", "root", "/root"],
] as const;

export const selectCatalogHomes = (
  arch: string,
  capabilities: Pick<ProviderCapabilities, "architectureEmulation">,
  providerArch: string = arch,
) => {
  const amd64 = (value: string) => ["x64", "amd64", "x86_64"].includes(value);
  const supportsMssql = (amd64(arch) && amd64(providerArch)) || capabilities.architectureEmulation;
  const supported = catalogHomes.filter(([type]) => supportsMssql || !type.startsWith("mssql"));
  const excluded = catalogHomes.filter(([type]) => !supportsMssql && type.startsWith("mssql"));
  return { supported, excluded };
};
