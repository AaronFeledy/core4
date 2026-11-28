import { resolveAppliedStateTarget } from "@lando/engine/operations/applied-state-target";
import { observedAppPlan } from "@lando/engine/providers/app-placement";
import { type HostProxyOpenerError, canOpenHost, openUrl } from "@lando/engine/services/host-opener";
import { RedactionService } from "@lando/redaction/service";
import type { InfoAppError } from "@lando/sdk/app";
import type {
  CommandInputValidationError,
  ComposeKeyRejectedError,
  EventError,
  LandofileLoadExpressionError,
  OpenTargetUnresolvedError,
  ProxyError,
} from "@lando/sdk/errors";
import { HostProxyOpenUrlSchemeError } from "@lando/sdk/errors";
import { PostOpenUrlEvent, PreOpenUrlEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, StartedService } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import {
  AppPlanner,
  EventService,
  LandofileService,
  type RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { DateTime, Effect, Exit, Schema } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution";
import { isEnvelopeResultFormat } from "../format-flags";
import type { RenderContext } from "../renderer-boundary";
import { commandResultFormat, specArgsOf, specFlagsOf, stringFlag } from "../spec/input-coercion";
import { appendTerminalQr } from "../terminal-qr";
import { collectOpenConnections } from "./open-connections";
import { diagnoseBrowserRoute, diagnoseUnresolvedOpenTarget } from "./open-diagnosis";
import { resolveHostnameTarget } from "./open-hostname";
import { validateOpenSelection } from "./open-input";
import { type OpenTarget, OpenTargetSchema, resolveOpenTargets } from "./open-targets";

export type { OpenTarget, OpenTargetSelection } from "./open-targets";
export { OpenTargetSchema, resolveOpenTargets } from "./open-targets";

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
  readonly hostname?: string;
  readonly all?: boolean;
  readonly print?: boolean;
  readonly qr?: boolean;
  readonly json?: boolean;
  readonly ttyPresent?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const openOptionsFromInput = (input: unknown): OpenAppOptions => {
  const flags = specFlagsOf(input);
  const service = stringFlag(flags, "service");
  const hostname = stringFlag(specArgsOf(input), "hostname");
  return {
    ...(service === undefined ? {} : { service }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(typeof flags.all === "boolean" ? { all: flags.all } : {}),
    ...(typeof flags.print === "boolean" ? { print: flags.print } : {}),
    ...(flags.qr === true ? { qr: true } : {}),
    json: isEnvelopeResultFormat(commandResultFormat(input)),
  };
};

export type OpenAppError =
  | CommandInputValidationError
  | ComposeKeyRejectedError
  | OpenTargetUnresolvedError
  | HostProxyOpenUrlSchemeError
  | HostProxyOpenerError
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
): Effect.fn.Return<OpenAppResult, OpenAppError, ProcessRunner | EventService | RedactionService> {
  const selected = resolveOpenTargets(plan, options, connections);
  if (selected.length === 0)
    return yield* Effect.fail(diagnoseUnresolvedOpenTarget(plan, options, connections));

  const targets: OpenTarget[] = [];
  for (const { routePath, ...target } of selected) {
    if (routePath !== undefined) {
      const browserError = diagnoseBrowserRoute(plan, target, routePath);
      if (browserError !== undefined) return yield* Effect.fail(browserError);
    }
    targets.push(target);
  }
  return yield* launchOpenTargets(plan, options, targets);
});

const launchOpenTargets = Effect.fnUntraced(function* (
  plan: AppPlan,
  options: OpenAppOptions,
  targets: readonly OpenTarget[],
) {
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
  const invocation = yield* CliInvocation;
  const env = options.env ?? invocation.env;
  if (!canOpenHost({ platform, env })) {
    return { app: plan.name, targets, launch: "headless-degraded" as const, note: HEADLESS_NOTE };
  }

  const explicitSelection = options.service !== undefined || options.hostname !== undefined;
  if (
    options.json === true &&
    !(explicitSelection && (options.ttyPresent ?? invocation.io.stdoutIsTTY) === true)
  ) {
    return { app: plan.name, targets, launch: "printed" as const };
  }

  const events = yield* EventService;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: env });
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
  | ProcessRunner
  | EventService
  | RedactionService
  | RouterService;

export const openApp = Effect.fn("OpenApp.open")(function* (
  options: OpenAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<OpenAppResult, OpenAppError | InfoAppError, OpenAppServices> {
  const selectionError = validateOpenSelection(options);
  if (selectionError !== undefined) return yield* Effect.fail(selectionError);

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

  if (options.hostname !== undefined) {
    const selected = yield* resolveHostnameTarget(plan, options.hostname.toLowerCase());
    return yield* launchOpenTargets(plan, options, [selected]);
  }
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
