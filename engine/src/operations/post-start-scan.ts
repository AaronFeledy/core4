import { DateTime, Effect } from "effect";

import { listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { expectedTcpListener } from "@lando/container-runtime/listener-observation";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type CheckResult,
  type EndpointRef,
  type ListenerObservation,
  ServiceName,
  type ServicePlan,
  type StartedService,
} from "@lando/sdk/schema";
import type { EventServiceShape, ScanEndpoint, UrlScannerShape } from "@lando/sdk/services";
import { makeTaskTree } from "@lando/sdk/task-progress";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { endpointScanPolicy } from "../services/endpoint-scan.ts";
import { scanTargets } from "../subsystems/scanner/connection-targets.ts";
import { startScanTreeId } from "./start-progress.ts";

export interface PostStartScanInput {
  readonly scanner: UrlScannerShape;
  readonly plan: AppPlan;
  readonly events: Pick<EventServiceShape, "publish">;
  readonly observeListener?: (service: ServicePlan) => Effect.Effect<ListenerObservation | undefined>;
  readonly urls: ReadonlyArray<{
    readonly service: ServiceName;
    readonly url: string;
    readonly endpoint?: EndpointRef;
  }>;
}

export const startupScanUrls = (
  plan: AppPlan,
  services: readonly StartedService[],
): PostStartScanInput["urls"] => {
  const targets = services.flatMap((service) => {
    const name = ServiceName.make(service.name);
    const planned = plan.services[name];
    if (planned?.scanner?.enabled === false) return [];
    return service.connections.flatMap((connection) =>
      scanTargets(
        [{ ...connection, service: name }],
        endpointScanPolicy(planned, connection.endpoint)?.path ?? planned?.scanner?.path ?? "/",
      ),
    );
  });
  return [...new Map(targets.map((target) => [`${target.service}/${target.url}`, target])).values()];
};

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

export const runPostStartScan = Effect.fnUntraced(function* (
  input: PostStartScanInput,
): Effect.fn.Return<ReadonlyArray<CheckResult>> {
  const counts = new Map<ServiceName, number>();
  const targets = input.urls.flatMap((target) => {
    const protocol = URL.parse(target.url)?.protocol;
    if (input.plan.services[target.service]?.scanner?.enabled === false) return [];
    if (protocol !== "http:" && protocol !== "https:") return [];
    const occurrence = (counts.get(target.service) ?? 0) + 1;
    counts.set(target.service, occurrence);
    return [{ ...target, id: `${target.service}-${occurrence}`, label: `${target.service} ${target.url}` }];
  });
  if (targets.length === 0) return [];
  const redactor = yield* resolveRedactor;
  const redact = (value: string): string => redactor.redactString(value);
  const listeners = new Map(
    yield* Effect.forEach(Object.values(input.plan.services), (service) =>
      Effect.cached(Effect.suspend(() => input.observeListener?.(service) ?? Effect.succeed(undefined))).pipe(
        Effect.map((observe) => [service.name, observe] as const),
      ),
    ),
  );
  const events = {
    publish: (event: Parameters<EventServiceShape["publish"]>[0]) =>
      Effect.suspend(() => input.events.publish(event)).pipe(Effect.catchCause(() => Effect.void)),
  };
  const tree = makeTaskTree(events, {
    parentId: startScanTreeId(input.plan.id),
    label: redact(`Checking ${input.plan.name}`),
    children: targets.map((target) => ({ id: target.id, label: redact(target.label) })),
    prefixChildIds: true,
  });
  return yield* tree.start.pipe(
    Effect.andThen(
      Effect.forEach(
        targets,
        Effect.fnUntraced(function* (target) {
          yield* tree.startTask(target.id);
          const scanned = yield* Effect.result(
            input.scanner.scan(input.plan.id, {
              plan: input.plan,
              urls: [
                {
                  service: target.service,
                  url: target.url,
                  ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
                },
              ],
              onAttempt: (attempt) =>
                (attempt.verdict !== "lando-error" && attempt.verdict !== "service-error") ||
                attempt.willRetry === false ||
                attempt.attempt >= attempt.maxAttempts
                  ? Effect.void
                  : tree.detail(
                      target.id,
                      "stderr",
                      redact(
                        `attempt ${attempt.attempt}/${attempt.maxAttempts}: ${attempt.detail ?? "no response"}`,
                      ),
                    ),
            }),
          );
          const endpoint: ScanEndpoint =
            scanned._tag === "Failure"
              ? { ...target, reachable: false, verdict: "lando-error", detail: scanned.failure.message }
              : (scanned.success.endpoints[0] ?? {
                  ...target,
                  reachable: false,
                  verdict: "lando-error",
                  detail: "no response reported",
                });
          const detail = redact(
            endpoint.routerMarker === "no-route"
              ? "no route matched this hostname"
              : endpoint.routerMarker === "upstream-unreachable"
                ? `the router could not reach ${target.service}`
                : (endpoint.detail ?? "no response reported"),
          );
          const status = endpoint.statusCode ?? "HTTP response";
          const service = input.plan.services[target.service];
          const listener =
            endpoint.verdict === "lando-error" &&
            (endpoint.routerMarker === "upstream-unreachable" ||
              (scanned._tag === "Success" &&
                scanned.success.endpoints.length > 0 &&
                endpoint.routerMarker === undefined &&
                !endpoint.reachable)) &&
            service !== undefined &&
            target.endpoint !== undefined &&
            target.endpoint.transport === "tcp" &&
            target.endpoint.port === expectedTcpListener(service)?.port
              ? yield* listeners.get(service.name) ?? Effect.succeed(undefined)
              : undefined;
          const diagnostic =
            listener === undefined || service === undefined
              ? undefined
              : listenerDiagnostic(listener, service, "scan");
          let message: string;
          switch (endpoint.verdict) {
            case "ready":
              message = `${target.label} · ${status}`;
              yield* tree.completeTask(target.id, redact(message));
              break;
            case "app-error":
              message = `${target.label} · your app returned ${status}`;
              yield* tree.infoTask(target.id, redact(message));
              break;
            case "service-error":
              message = `${target.label} · web server returned ${status}`;
              yield* tree.warnTask(target.id, redact(message));
              break;
            case "lando-error":
              message = `${target.label} · unreachable: ${detail}`;
              yield* tree.warnTask(target.id, redact(message));
              yield* events.publish(
                MessageWarnEvent.make({
                  body: redact(
                    `Lando could not reach ${target.url}: ${detail}${diagnostic === undefined ? "" : `. ${diagnostic.finding.charAt(0).toUpperCase()}${diagnostic.finding.slice(1)}. ${diagnostic.action}${diagnostic.authority === undefined ? "" : ` ${diagnostic.authority}`}`}`,
                  ),
                  timestamp: yield* DateTime.now,
                }),
              );
              break;
            default: {
              const unreachable: never = endpoint.verdict;
              return unreachable;
            }
          }
          return {
            id: redact(`http:${target.service}:${target.url}`),
            kind: "http" as const,
            service: target.service,
            url: redact(target.url),
            verdict: endpoint.verdict,
            ...(endpoint.statusCode === undefined ? {} : { statusCode: endpoint.statusCode }),
            message: redact(message),
            ...(endpoint.verdict === "ready" ? {} : { detail }),
            ...(listener === undefined
              ? {}
              : {
                  listener: {
                    ...listener,
                    service: redact(listener.service),
                    listening: listener.listening.map((binding) => ({
                      ...binding,
                      address: redact(binding.address),
                    })),
                  },
                }),
          } satisfies CheckResult;
        }),
        { concurrency: 4 },
      ),
    ),
    Effect.tap((checks) => {
      const errors = checks.filter(
        (check) => check.verdict === "app-error" || check.verdict === "service-error",
      ).length;
      const unreachable = checks.filter((check) => check.verdict === "lando-error").length;
      const urls = (count: number) => `${count} URL${count === 1 ? "" : "s"}`;
      const parts: string[] = [];
      if (errors > 0) parts.push(`${urls(errors)} returned errors`);
      if (unreachable > 0) parts.push(`${unreachable} unreachable`);
      return tree.settleSuccess(
        redact(
          parts.length === 0
            ? `${input.plan.name} answered on ${urls(checks.length)}`
            : `${input.plan.name} checked · ${parts.join(", ")}`,
        ),
      );
    }),
    Effect.onInterrupt(() => tree.settleInterrupt(redact(`${input.plan.name} check interrupted`))),
  );
});
