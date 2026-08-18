import { Layer } from "effect";

import { makeBuiltInCommandCatalogLive } from "./built-in-command-catalog-service";
import { builtInCommandEntries } from "./built-in-command-registry";

export const BuiltInCommandCatalogLive = Layer.suspend(() =>
  makeBuiltInCommandCatalogLive(builtInCommandEntries),
);
