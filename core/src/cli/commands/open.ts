import { DateTime, Effect, Exit, Schema } from "effect";

import type { InfoAppError } from "@lando/sdk/app";
import type { EventError, ShellExecError } from "@lando/sdk/errors";
import { HostProxyOpenUrlSchemeError, OpenTargetUnresolvedError } from "@lando/sdk/errors";
import { PostOpenUrlEvent, PreOpenUrlEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanResolver,
  EventService,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import type { ShellRunner } from "@lando/sdk/services";

import { RedactionService } from "../../redaction/service.ts";
import { canOpenHost, openUrl } from "../../services/host-opener.ts";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import type { RenderContext } from "../renderer-boundary.ts";
import { OpenTargetSchema, isOpenableScheme, resolveOpenTargets } from "./open-targets.ts";

export {
  OpenTargetSchema,
  buildOpenTarget,
  isOpenableScheme,
  resolveOpenTargets,
} from "./open-targets.ts";
export type { OpenTarget, OpenTargetSelection } from "./open-targets.ts";

export const OpenLaunchOutcome = Schema.Literal("opened", "printed", "headless-degraded");
export type OpenLaunchOutcome = typeof OpenLaunchOutcome.Type;

export const OpenAppResultSchema = Schema.Struct({
  app: Schema.String,
  targets: Schema.Array(OpenTargetSchema),
  launch: OpenLaunchOutcome,
  note: Schema.optional(Schema.String),
});
export type OpenAppResult = typeof OpenAppResultSchema.Type;

export interface OpenAppOptions {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly json?: boolean;
  readonly ttyPresent?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface OpenFlags {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly format?: string;
}

const flagsFromInput = (input: unknown): OpenFlags =>
  typeof input === "object" && input !== null ? ((input as { readonly flags?: OpenFlags }).flags ?? {}) : {};

export const openOptionsFromInput = (input: unknown): OpenAppOptions => {
  const flags = flagsFromInput(input);
  return {
    ...(flags.service === undefined ? {} : { service: flags.service }),
    ...(flags.route === undefined ? {} : { route: flags.route }),
    ...(flags.all === undefined ? {} : { all: flags.all }),
    ...(flags.print === undefined ? {} : { print: flags.print }),
    json: flags.format === "json",
    ttyPresent: process.stdout.isTTY === true,
  };
};

export type OpenAppError =
  | OpenTargetUnresolvedError
  | HostProxyOpenUrlSchemeError
  | ShellExecError
  | EventError;

const HEADLESS_NOTE = "No display server detected; printing the URL instead of opening a browser.";

const openAppRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const openNow = () => DateTime.unsafeMake(new Date().toISOString());

export const openForPlan = (
  plan: AppPlan,
  options: OpenAppOptions = {},
): Effect.Effect<OpenAppResult, OpenAppError, ShellRunner | EventService | RedactionService> =>
  Effect.gen(function* () {
    const targets = resolveOpenTargets(plan, options);
    if (targets.length === 0) {
      const knownServices = Object.values(plan.services).map((service) => String(service.name));
      const knownServicesText = knownServices.length === 0 ? "none" : knownServices.join(", ");
      if (
        (options.service !== undefined || options.route !== undefined) &&
        resolveOpenTargets(plan, { all: true }).length > 0
      ) {
        const selected =
          options.route !== undefined ? `--route ${options.route}` : `--service ${options.service ?? ""}`;
        return yield* Effect.fail(
          new OpenTargetUnresolvedError({
            message: `No openable URL matched ${selected} for ${plan.name}. Known services: ${knownServicesText}.`,
            remediation: "Choose one of the listed services or routes, then rerun `lando open`.",
          }),
        );
      }
      return yield* Effect.fail(
        new OpenTargetUnresolvedError({
          message: `No openable URL for ${plan.name}: the app declares no matching proxy route. Known services: ${knownServicesText}.`,
          app: plan.name,
          services: knownServices,
          remediation: "Declare a proxy route under `proxy:` in your Landofile, then rerun `lando open`.",
        }),
      );
    }

    for (const target of targets) {
      if (!isOpenableScheme(target.url)) {
        return yield* Effect.fail(
          new HostProxyOpenUrlSchemeError({
            message: `Refusing to open ${target.url}: only http and https URLs can be opened.`,
            scheme: target.scheme,
            url: target.url,
            remediation: "Open only http:// or https:// URLs.",
          }),
        );
      }
    }

    if (options.print === true) return { app: plan.name, targets, launch: "printed" as const };

    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    if (!canOpenHost({ platform, env })) {
      return { app: plan.name, targets, launch: "headless-degraded" as const, note: HEADLESS_NOTE };
    }

    const explicitSelection = options.service !== undefined || options.route !== undefined;
    if (options.json === true && !(explicitSelection && options.ttyPresent === true)) {
      return { app: plan.name, targets, launch: "printed" as const };
    }

    const events = yield* EventService;
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const ref = openAppRef(plan);
    for (const target of targets) {
      const summary = redactor.redactString(target.url);
      yield* events.publish(PreOpenUrlEvent.make({ app: ref, url: summary, timestamp: openNow() }));
      const openExit = yield* Effect.exit(openUrl(target.url, { platform }));
      yield* events.publish(PostOpenUrlEvent.make({ app: ref, url: summary, timestamp: openNow() }));
      if (Exit.isFailure(openExit)) return yield* Effect.failCause(openExit.cause);
    }
    return { app: plan.name, targets, launch: "opened" as const };
  });

type OpenAppServices =
  | AppPlanResolver
  | LandofileService
  | RuntimeProviderRegistry
  | ShellRunner
  | EventService
  | RedactionService;

export const openApp = (
  options: OpenAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<OpenAppResult, OpenAppError | InfoAppError, OpenAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanResolver;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities, { kind: "user" });
      }));

    return yield* openForPlan(plan, options);
  });

export const renderOpenAppResult = (result: OpenAppResult, _ctx?: RenderContext): string => {
  if (result.targets.length === 0) return `${result.app}\n(no openable targets)\n`;
  const heading =
    result.launch === "opened"
      ? "Opened:"
      : result.launch === "headless-degraded"
        ? (result.note ?? "Resolved:")
        : "Resolved:";
  const lines = result.targets.map((target) => `${target.service}\t${target.url}`);
  return `${[heading, ...lines].join("\n")}\n`;
};
