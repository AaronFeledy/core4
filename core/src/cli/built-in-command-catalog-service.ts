import { Context, Layer } from "effect";

import type { BuiltInCommandEntry } from "./built-in-command-registry";

export type BuiltInCommandCatalogService = {
  readonly entries: ReadonlyArray<BuiltInCommandEntry>;
};

export class BuiltInCommandCatalog extends Context.Service<
  BuiltInCommandCatalog,
  BuiltInCommandCatalogService
>()("@lando/core/BuiltInCommandCatalog") {
  static readonly layerWith = (
    entries: ReadonlyArray<BuiltInCommandEntry>,
  ): Layer.Layer<BuiltInCommandCatalog> => Layer.succeed(this, this.of({ entries }));
}
