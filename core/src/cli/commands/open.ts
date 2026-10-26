import { DateTime, Effect, Exit, Schema } from "effect";

import type { InfoAppError } from "@lando/sdk/app";
import type {
  ComposeKeyRejectedError,
  EventError,
  LandofileLoadExpressionError,
  ProxyError,
  ShellExecError,
} from "@lando/sdk/errors";
import { HostProxyOpenUrlSchemeError, OpenTargetUnresolvedError } from "@lando/sdk/errors";
import { PostOpenUrlEvent, PreOpenUrlEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, StartedService } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  type RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import type { ShellRunner } from "@lando/sdk/services";

import { routerEnabled } from "@lando/engine/config/router-config";
import { resolveAppliedStateTarget } from "@lando/engine/operations/applied-state-target";
import { observedAppPlan } from "@lando/engine/providers/app-placement";
import { canOpenHost, openUrl } from "@lando/engine/services/host-opener";
import { RedactionService } from "@lando/redaction/service";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution";
import { isEnvelopeResultFormat } from "../format-flags";
import type { RenderContext } from "../renderer-boundary";
import { appendTerminalQr } from "../terminal-qr";
import { collectOpenConnections } from "./open-connections";
import { OpenTargetSchema, resolveOpenTargets } from "./open-targets";
export { OpenTargetSchema, resolveOpenTargets } from "./open-targets";
export type { OpenTarget, OpenTargetSelection } from "./open-targets";

export const OpenLaunchOutcome = Schema.Literals(["opened", "printed", "headless-degraded"]);
export type OpenLaunchOutcome = typeof OpenLaunchOutcome.Type;

export const OpenAppResultSchema = Schema.Struct({
  app: Schema.String,
  targets: Schema.Array(OpenTargetSchema),
  launch: OpenLaunchOutcome,
  note: Schema.optionalKey(Schema.String),
});
export type OpenAppResult = typeof OpenAppResultSchema.Type;

const OPENABLE_SCHEMES = new Set(["http:", "https:"]);

export const isOpenableScheme = (url: string): boolean => {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

export interface OpenAppOptions {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly qr?: boolean;
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
  readonly qr?: boolean;
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
    ...(flags.qr === true ? { qr: true } : {}),
    json: isEnvelopeResultFormat(flags.format),
    ttyPresent: process.stdout.isTTY === true,
  };
};

export type OpenAppError =
  | ComposeKeyRejectedError
  | OpenTargetUnresolvedError
  | HostProxyOpenUrlSchemeError
  | ShellExecError
  | ProxyError
  | EventError
  | LandofileLoadExpressionError;

const HEADLESS_NOTE = "No display server detected; printing the URL instead of opening a browser.";

const openAppRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const openNow = () => DateTime.nowUnsafe();

export const openForPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  options: OpenAppOptions,
  connections: readonly StartedService[],
): Effect.fn.Return<OpenAppResult, OpenAppError, ShellRunner | EventService | RedactionService> {
  const targets = resolveOpenTargets(plan, options, connections);
  if (targets.length === 0) {
    const knownServices = Object.values(plan.services).map((service) => String(service.name));
    const knownServicesText = knownServices.length === 0 ? "none" : knownServices.join(", ");
    const unpublishedRoutes = !routerEnabled(plan) && plan.routes.length > 0;
    const askedForUnpublishedRoute =
      unpublishedRoutes &&
      options.route !== undefined &&
      plan.routes.some((route) => route.hostname === options.route);
    if (askedForUnpublishedRoute) {
      return yield* Effect.fail(
        new OpenTargetUnresolvedError({
          message: `No openable URL matched --route ${options.route} for ${plan.name}: that hostname is declared but the router is disabled. Known services: ${knownServicesText}.`,
          remediation:
            "Set `router:` `enabled: true` in your Landofile to publish the declared routes, or omit `--route` to open a published http host port.",
        }),
      );
    }
    if (
      (options.service !== undefined || options.route !== undefined) &&
      resolveOpenTargets(plan, { all: true }, connections).length > 0
    ) {
      const selected =
        options.route !== undefined ? `--route ${options.route}` : `--service ${options.service ?? ""}`;
      return yield* Effect.fail(
        new OpenTargetUnresolvedError({
          message: `No openable URL matched ${selected} for ${plan.name}. Known services: ${knownServicesText}.`,
          remediation:
            "Choose one of the listed services or routes. For multiple HTTP listeners, select an explicit --route or mark the intended HTTP endpoint primary: true, then rerun `lando open`.",
        }),
      );
    }
    return yield* Effect.fail(
      new OpenTargetUnresolvedError({
        message: unpublishedRoutes
          ? `No openable URL for ${plan.name}: its routes are declared but the router is disabled, and no service publishes an http host port. Known services: ${knownServicesText}.`
          : `No active host HTTP(S) connection for ${plan.name}. Known services: ${knownServicesText}.`,
        app: plan.name,
        services: knownServices,
        remediation: unpublishedRoutes
          ? "Set `router:` `enabled: true` in your Landofile to publish the declared routes, or publish an http endpoint on a host port, then rerun `lando open`."
          : "Start the app and ensure its proxy routes or HTTP host publications are active. For multiple HTTP listeners, select an explicit --route or mark the intended HTTP endpoint primary: true, then rerun `lando open`.",
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

  if (options.print === true || options.qr === true)
    return { app: plan.name, targets, launch: "printed" as const };

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
  | AppPlanner
  | LandofileService
  | RuntimeProviderRegistry
  | ShellRunner
  | EventService
  | RedactionService
  | RouterService;

export const openApp = Effect.fn("OpenApp.open")(function* (
  options: OpenAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<OpenAppResult, OpenAppError | InfoAppError, OpenAppServices> {
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;

  const resolved = target ?? (yield* resolveAppliedStateTarget);
  const plan = yield* observedAppPlan(
    resolved?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      })),
  );

  const connections = yield* collectOpenConnections(plan, options);
  return yield* openForPlan(plan, options, connections);
});

export const renderOpenAppResult = (
  result: OpenAppResult,
  ctx?: RenderContext,
  options: Pick<OpenAppOptions, "qr"> = {},
): string => {
  if (result.targets.length === 0) return `${result.app}\n(no openable targets)\n`;
  const heading =
    result.launch === "opened"
      ? "Opened:"
      : result.launch === "headless-degraded"
        ? (result.note ?? "Resolved:")
        : "Resolved:";
  const lines = result.targets.map((target) => `${target.service}\t${target.url}`);
  const text = `${[heading, ...lines].join("\n")}\n`;
  if (options.qr !== true) return text;
  return result.targets.reduce(
    (output, target) =>
      appendTerminalQr(output, {
        url: target.url,
        isTTY: ctx?.isTTY === true,
        ...(ctx?.format === undefined ? {} : { format: ctx.format }),
        force: true,
      }),
    text,
  );
};
