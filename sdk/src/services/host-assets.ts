import { Context, type Effect } from "effect";

import type { ContainerHelperUnavailableError } from "../errors/container-helper.ts";
import type { ContainerHelperArtifact, ContainerHelperTarget } from "../schema/container-helper.ts";

/**
 * Lazy host-side resolver for the static in-container helper. Resolve only when
 * installing it into a container (host-proxy session or log-file follow), never
 * at provider construction.
 */
export class ContainerHelperAssets extends Context.Service<
  ContainerHelperAssets,
  {
    readonly resolve: (
      target: ContainerHelperTarget,
    ) => Effect.Effect<ContainerHelperArtifact, ContainerHelperUnavailableError>;
  }
>()("@lando/core/ContainerHelperAssets") {}

export type ContainerHelperAssetsShape = ContainerHelperAssets["Service"];
