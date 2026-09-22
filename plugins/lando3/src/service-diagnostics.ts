import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { Lando3Path, LegacyOccurrence } from "./contract.ts";
import type { ServiceLoweringContext } from "./lowering-contract.ts";
import { formatPath } from "./source.ts";

type ServiceLocation = {
  readonly ctx: ServiceLoweringContext;
  readonly relative: Lando3Path;
};

type ServiceDiagnosticInput = ServiceLocation & {
  readonly message: string;
  readonly remediation: string;
};

export const spanOf = (occurrence: LegacyOccurrence | undefined): ConfigTranslateDiagnostic["span"] =>
  occurrence?.span === undefined
    ? undefined
    : {
        start: { line: occurrence.span.start.line, column: occurrence.span.start.column },
        end: { line: occurrence.span.end.line, column: occurrence.span.end.column },
      };

const serviceDiagnostic = (
  kind: ConfigTranslateDiagnostic["kind"],
  args: ServiceDiagnosticInput,
): ConfigTranslateDiagnostic => {
  const occurrence = args.ctx.occurrenceAt(args.relative);
  return {
    kind,
    sourceId: occurrence?.sourceId ?? ConfigTranslateSourceId.make(args.ctx.fallbackSourceId),
    keyPath: [...args.ctx.keyPath, ...args.relative],
    span: spanOf(occurrence),
    message: args.message,
    remediation:
      args.remediation.trim() === "" ? "Review this setting in the generated Landofile." : args.remediation,
  };
};

export const droppedServiceKey = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("dropped", args);

export const unsupportedServiceKey = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("unsupported", args);

export const rewrittenServiceKey = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("rewritten", args);

export const nonPortableServiceKey = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("non-portable", args);

export const needsReviewServiceKey = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("needs-review", args);

export const generatedService = (args: ServiceDiagnosticInput): ConfigTranslateDiagnostic =>
  serviceDiagnostic("generated", args);

/**
 * Keys whose Lando 4 target is owned by work that has not landed yet. They are
 * dropped rather than rejected, so they never block conversion, and the
 * remediation names the pending work so the user knows when to convert again.
 */
const DEFERRED_KEYS = {
  scanner: { target: "service scanner", story: "US-617B" },
  home: { target: "default home storage", story: "US-617A" },
  mem: { target: "catalog memory setting", story: "US-621C8" },
  plugins: { target: "catalog plugin installation", story: "US-621C8" },
  xdebug: { target: "typed xdebug settings", story: "US-621C8" },
} as const;

export type DeferredServiceKey = keyof typeof DEFERRED_KEYS;

export const deferredServiceKey = (
  args: ServiceLocation & { readonly key: DeferredServiceKey },
): ConfigTranslateDiagnostic => {
  const { target, story } = DEFERRED_KEYS[args.key];
  return droppedServiceKey({
    ctx: args.ctx,
    relative: args.relative,
    message: `${formatPath([...args.ctx.keyPath, ...args.relative])} was dropped: Lando 4 has no ${target} until ${story} lands.`,
    remediation: `Configure the equivalent by hand in the generated Landofile, or convert again after ${story} lands.`,
  });
};

export const droppedMoreHttpPorts = (args: ServiceLocation): ConfigTranslateDiagnostic =>
  droppedServiceKey({
    ...args,
    message: "moreHttpPorts has no Lando 4 target.",
    remediation:
      "Declare each extra HTTP port as an endpoint on the service, and route it by hand if needed.",
  });

export const rewrittenMeUser = (args: Pick<ServiceLocation, "ctx">): ConfigTranslateDiagnostic =>
  rewrittenServiceKey({
    ctx: args.ctx,
    relative: ["meUser"],
    message: "Rewrote meUser as the service user.",
    remediation: "Review user in the generated service.",
  });

export const unsupportedVersion = (
  args: ServiceLocation & {
    readonly type: string;
    readonly version: string;
    readonly supported: ReadonlyArray<string>;
  },
): ConfigTranslateDiagnostic =>
  unsupportedServiceKey({
    ...args,
    message: `${args.type} version ${args.version === "" ? "(unspecified)" : args.version} is not available in Lando 4.`,
    remediation: `${
      args.supported.length === 0
        ? `${args.type} publishes no versions; use its bare type or add an image.`
        : `Choose a supported ${args.type} version: ${args.supported.join(", ")}.`
    } Lando will not build an image for an unavailable version.`,
  });

export const missingImage = (args: {
  readonly ctx: ServiceLoweringContext;
}): ConfigTranslateDiagnostic =>
  unsupportedServiceKey({
    ...args,
    relative: [],
    message: `Service ${args.ctx.serviceName} has no image to convert.`,
    remediation: "Add an image to this service before converting it.",
  });

export const rejectedComposeKey = (
  args: ServiceLocation & {
    readonly key: string;
  },
): ConfigTranslateDiagnostic =>
  unsupportedServiceKey({
    ...args,
    message: `Compose field ${args.key} cannot be converted to Lando 4.`,
    remediation:
      "This field shapes container execution and has no Lando 4 equivalent, so the service is not converted. Author an equivalent service by hand.",
  });

export const unsafeBuildSource = (
  args: ServiceLocation & {
    readonly detail: string;
  },
): ConfigTranslateDiagnostic =>
  unsupportedServiceKey({
    ...args,
    message: `The build source cannot be converted safely: ${args.detail}`,
    remediation:
      "Use a local build source inside the app root, or add an image and configure the build by hand.",
  });
