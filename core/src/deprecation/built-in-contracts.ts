import { Effect } from "effect";

import type { DeprecationContradictionError } from "@lando/sdk/errors";
import type { DeprecationNotice } from "@lando/sdk/schema";
import type { DeprecationService } from "@lando/sdk/services";

interface DeprecatedFieldContract {
  readonly deprecated?: DeprecationNotice;
}

export interface DeprecationContractAlias {
  readonly name: string;
  readonly deprecated?: DeprecationNotice;
}

export type DeprecationContractAliasEntry = string | DeprecationContractAlias;

export type DeprecationContractTopLevelAlias =
  | boolean
  | string
  | DeprecationContractAlias
  | ReadonlyArray<DeprecationContractAliasEntry>;

export interface DeprecationContractCommand {
  readonly id: string;
  readonly deprecated?: DeprecationNotice;
  readonly topLevelAlias?: DeprecationContractTopLevelAlias;
  readonly aliases?: ReadonlyArray<DeprecationContractAliasEntry>;
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface DeprecationContractSurface {
  readonly id: string;
  readonly deprecated?: DeprecationNotice;
}

export interface DeprecationBuiltInContracts {
  readonly commands?: ReadonlyArray<DeprecationContractCommand>;
  readonly lifecycleEvents?: ReadonlyArray<DeprecationContractSurface>;
  readonly eventFields?: ReadonlyArray<DeprecationContractSurface>;
  readonly renderEvents?: ReadonlyArray<DeprecationContractSurface>;
  readonly serviceTypes?: ReadonlyArray<DeprecationContractSurface>;
  readonly serviceFeatures?: ReadonlyArray<DeprecationContractSurface>;
  readonly routeFilters?: ReadonlyArray<DeprecationContractSurface>;
}

export const BUILT_IN_COMMAND_DEPRECATIONS: ReadonlyArray<DeprecationContractCommand> = [
  {
    id: "app:shell",
    flags: {
      host: {
        deprecated: {
          since: "4.2.0",
          severity: "warn",
          replacement: "--service <name>",
          note: "lando shell now opens a host shell by default; --host is redundant. Pass --service <name> to open a shell inside a service instead.",
        },
      },
    },
  },
];
export const BUILT_IN_CONTRACT_DEPRECATIONS: DeprecationBuiltInContracts = {
  commands: BUILT_IN_COMMAND_DEPRECATIONS,
};

const isDeprecatedField = (value: unknown): value is DeprecatedFieldContract =>
  typeof value === "object" && value !== null && "deprecated" in value;

const aliasName = (entry: DeprecationContractAliasEntry): string =>
  typeof entry === "string" ? entry : entry.name;

const aliasNotice = (
  entry: DeprecationContractAliasEntry,
  canonicalNotice: DeprecationNotice | undefined,
): DeprecationNotice | undefined =>
  typeof entry === "string" ? canonicalNotice : (entry.deprecated ?? canonicalNotice);

const isAliasEntryArray = (
  value: Exclude<DeprecationContractTopLevelAlias, undefined>,
): value is ReadonlyArray<DeprecationContractAliasEntry> => Array.isArray(value);

const topLevelAliasEntries = (
  command: DeprecationContractCommand,
): ReadonlyArray<DeprecationContractAliasEntry> => {
  const top = command.topLevelAlias;
  if (top === undefined || top === false) return [];
  if (top === true) return [command.id.replace(/^[^:]+:/, "")];
  if (typeof top === "string") return [top];
  if (isAliasEntryArray(top)) return top;
  return [top];
};

export const registerBuiltInCommandDeprecations = (
  deprecations: typeof DeprecationService.Service,
  commands: ReadonlyArray<DeprecationContractCommand> = BUILT_IN_COMMAND_DEPRECATIONS,
): Effect.Effect<void, DeprecationContradictionError> =>
  Effect.gen(function* () {
    for (const command of commands) {
      if (command.deprecated !== undefined) {
        yield* deprecations.register("core", "command", command.id, command.deprecated);
      }
      for (const entry of [...topLevelAliasEntries(command), ...(command.aliases ?? [])]) {
        yield* deprecations.registerAlias(
          "core",
          "command",
          command.id,
          aliasName(entry),
          aliasNotice(entry, command.deprecated),
        );
      }
      for (const [name, spec] of Object.entries(command.flags ?? {})) {
        if (isDeprecatedField(spec) && spec.deprecated !== undefined) {
          yield* deprecations.register("core", "flag", `${command.id} --${name}`, spec.deprecated);
        }
      }
      for (const [name, spec] of Object.entries(command.args ?? {})) {
        if (isDeprecatedField(spec) && spec.deprecated !== undefined) {
          yield* deprecations.register("core", "arg", `${command.id} ${name}`, spec.deprecated);
        }
      }
    }
  });

const registerContractSurfaces = (
  deprecations: typeof DeprecationService.Service,
  kind: "event" | "event-field" | "render-event" | "service-type" | "service-feature" | "route-filter",
  surfaces: ReadonlyArray<DeprecationContractSurface> = [],
): Effect.Effect<void, DeprecationContradictionError> =>
  Effect.gen(function* () {
    for (const surface of surfaces) {
      if (surface.deprecated !== undefined) {
        yield* deprecations.register("core", kind, surface.id, surface.deprecated);
      }
    }
  });

export const registerBuiltInContractDeprecations = (
  deprecations: typeof DeprecationService.Service,
  contracts: DeprecationBuiltInContracts = BUILT_IN_CONTRACT_DEPRECATIONS,
): Effect.Effect<void, DeprecationContradictionError> =>
  Effect.gen(function* () {
    yield* registerBuiltInCommandDeprecations(deprecations, contracts.commands ?? []);
    yield* registerContractSurfaces(deprecations, "event", contracts.lifecycleEvents);
    yield* registerContractSurfaces(deprecations, "event-field", contracts.eventFields);
    yield* registerContractSurfaces(deprecations, "render-event", contracts.renderEvents);
    yield* registerContractSurfaces(deprecations, "service-type", contracts.serviceTypes);
    yield* registerContractSurfaces(deprecations, "service-feature", contracts.serviceFeatures);
    yield* registerContractSurfaces(deprecations, "route-filter", contracts.routeFilters);
  });
