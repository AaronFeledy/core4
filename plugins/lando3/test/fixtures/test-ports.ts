import { createRedactor } from "@lando/sdk/secrets";
import type { Lando3TranslatorPorts } from "../../src/contract.ts";
import { makeLando3ConfigTranslator } from "../../src/translator.ts";
import { fakeDecomposers } from "./fake-decomposers.ts";
import { serviceFacts } from "./service-facts.ts";

export const testPorts = (overrides: Partial<Lando3TranslatorPorts> = {}): Lando3TranslatorPorts => ({
  serviceFacts,
  decomposers: fakeDecomposers().decomposers,
  redactor: createRedactor("secrets"),
  ...overrides,
});

export const makeTestTranslator = (overrides: Partial<Lando3TranslatorPorts> = {}) =>
  makeLando3ConfigTranslator(testPorts(overrides));

export const testTranslator = makeTestTranslator();
