import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { JSON_SCHEMA_NAMES, publicSchemaRegistry } from "@lando/sdk/schema";

import { namedContractTables } from "./contract-examples/index.ts";
import { PUBLIC_SCHEMA_CONTRACT_FIXTURES } from "./public-schema-contracts.ts";

/**
 * Hard-coded published named-contract boundary list.
 * mirrors the published boundary list; tests may not read spec/
 */
const PUBLISHED_NAMED_CONTRACTS = [
  "PortablePath",
  "ProviderId",
  "EndpointInput",
  "RouteInput",
  "HealthcheckInput",
  "LogSourceInput",
  "AppMountInput",
  "MountInput",
  "StorageInput",
  "CertsInput",
  "CaInput",
  "CommandSpec",
  "ContainerUser",
] as const;

const decodeOptions = [{}, { onExcessProperty: "error" as const }] as const;

describe("named contract examples", () => {
  test("tables cover the published boundary list and registry fixtures", () => {
    const tableNames = namedContractTables.map((table) => table.name).sort();
    expect(tableNames).toEqual([...PUBLISHED_NAMED_CONTRACTS].sort());
    const moduleNames = [...new Bun.Glob("*.ts").scanSync(`${import.meta.dirname}/contract-examples`)]
      .filter((file) => file !== "index.ts" && file !== "types.ts")
      .map((file) => file.slice(0, -3))
      .sort();
    expect(moduleNames).toEqual(
      PUBLISHED_NAMED_CONTRACTS.map((name) => name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()).sort(),
    );

    for (const name of PUBLISHED_NAMED_CONTRACTS) {
      expect(JSON_SCHEMA_NAMES.includes(name), `${name} must be registered`).toBe(true);
      expect(publicSchemaRegistry[name], `${name} registry entry`).toBeDefined();
      expect(PUBLIC_SCHEMA_CONTRACT_FIXTURES[name], `${name} contract fixture`).toBeDefined();
    }
  });

  for (const table of namedContractTables) {
    describe(table.name, () => {
      test.each([...table.accepted])("accepts $name under defaults and strict", ({ input, expected }) => {
        for (const options of decodeOptions) {
          const decoded = Schema.decodeUnknownSync(table.schema)(input, options);
          if (expected !== undefined) expect(decoded).toEqual(expected);

          const encoded = Schema.encodeUnknownSync(table.schema)(decoded, options);
          const roundTripped = Schema.decodeUnknownSync(table.schema)(encoded, options);
          expect(roundTripped).toEqual(decoded);
        }
      });

      test.each([...table.rejected])(
        "rejects $name under defaults and strict with fragment",
        ({ input, expectedErrorFragment }) => {
          for (const options of decodeOptions) {
            const result = Schema.decodeUnknownResult(table.schema)(input, options);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(String(result.failure)).toContain(expectedErrorFragment);
            }
          }
        },
      );
    });
  }
});
