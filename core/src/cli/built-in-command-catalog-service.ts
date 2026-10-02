import { Context, Layer } from "effect";

import type { BuiltInCommandEntry } from "./built-in-command-registry";

export type BuiltInCommandCatalogService = {
  readonly entries: ReadonlyArray<BuiltInCommandEntry>;
};

export class BuiltInCommandCatalog extends Context.Service<BuiltInCommandCatalog, BuiltInCommandCatalogService>()("@lando/core/BuiltInCommandCatalog") {}

export const makeBuiltInCommandCatalogLive = (
  entries: ReadonlyArray<BuiltInCommandEntry>,
): Layer.Layer<BuiltInCommandCatalog> => Layer.succeed(BuiltInCommandCatalog, { entries });
