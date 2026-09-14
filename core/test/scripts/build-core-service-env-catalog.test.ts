import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CoreServiceEnvCatalogModule = {
  readonly collectCoreServiceEnvKeys: () => Promise<ReadonlyArray<string>>;
};

const isCoreServiceEnvCatalogModule = (value: unknown): value is CoreServiceEnvCatalogModule =>
  typeof value === "object" &&
  value !== null &&
  "collectCoreServiceEnvKeys" in value &&
  typeof value.collectCoreServiceEnvKeys === "function";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const moduleUrl = pathToFileURL(resolve(repositoryRoot, "scripts/build-core-service-env-catalog.ts")).href;
const importedModule: unknown = await import(moduleUrl);
if (!isCoreServiceEnvCatalogModule(importedModule)) {
  throw new TypeError("core service environment catalog module does not satisfy its runtime contract");
}
const { collectCoreServiceEnvKeys } = importedModule;

test("Given bare core environment properties, when collecting the catalog, then their keys are reserved", async () => {
  // Given
  const expectedKeys = ["LANDO_DB_USER", "LANDO_DB_PASSWORD", "LANDO_DB_NAME"];

  // When
  const keys = await collectCoreServiceEnvKeys();

  // Then
  expect(keys).toEqual(expect.arrayContaining(expectedKeys));
});
