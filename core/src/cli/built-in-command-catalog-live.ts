import { Layer } from "effect";

import { BuiltInCommandCatalog } from "./built-in-command-catalog-service";
import { builtInCommandEntries } from "./built-in-command-registry";

export const layer = Layer.suspend(() => BuiltInCommandCatalog.layerWith(builtInCommandEntries));
