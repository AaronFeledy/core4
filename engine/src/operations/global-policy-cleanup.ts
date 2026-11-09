import { AppId, type AppPlan } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { Effect } from "effect";
import { GlobalPolicyReconciliationError } from "../global-app/errors.ts";
import {
  type GlobalReconciliationPending,
  type GlobalReconciliationTarget,
  pendingWork,
  recordGlobalReconciliation,
  transitionGlobalPending,
} from "../global-app/reconciliation.ts";
import type { GlobalResolution } from "../global-app/resolution.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { classifyGlobalCleanupInventory, dependencyError } from "./global-policy-cleanup-evidence.ts";
import type { GlobalPolicyChangeResult } from "./global-policy.ts";
import { resolveGlobalStopSelection, resolveGlobalTeardown } from "./global-teardown.ts";

export const cleanupDisabledGlobalResources = Effect.fn("GlobalPolicy.cleanupDisabledResources")(
  function* (input: {
    readonly receipt: GlobalPolicyChangeResult;
    readonly candidate: GlobalResolution;
    readonly targets: ReadonlyArray<GlobalReconciliationTarget>;
    readonly priorRouteIds: ReadonlyArray<string>;
    readonly routesClearedRevision?: number;
    readonly dependencyBlockers: (plan: AppPlan) => ReadonlyArray<string>;
  }) {
    let receipt = {
      ...input.receipt,
      pending: yield* Effect.fromResult(
        transitionGlobalPending(input.receipt.pending, "evidence", { clears: [{ phase: "evidence" }] }),
      ),
    };
    const ids = input.receipt.contributions;
    const selected = new Set(ids);
    const causes: unknown[] = [];
    const pending = Effect.fnUntraced(function* (
      operation: "evidence" | "discovery" | "containers",
      work: GlobalReconciliationPending,
    ) {
      receipt = {
        ...receipt,
        pending: yield* Effect.fromResult(
          transitionGlobalPending(receipt.pending, operation, { adds: [work] }),
        ),
      };
    });
    const persist = Effect.fnUntraced(function* () {
      const result = yield* Effect.result(
        recordGlobalReconciliation({
          revision: receipt.revision,
          operation: receipt.operation,
          contributions: receipt.contributions,
          targets: input.targets,
          servicesRemoved: receipt.servicesRemoved,
          pending: receipt.pending,
        }),
      );
      if (result._tag === "Failure")
        return yield* Effect.fail(
          new GlobalPolicyReconciliationError({
            message: "Global service policy is saved, but cleanup progress could not be recorded.",
            operation: receipt.operation,
            policySaved: true,
            revision: receipt.revision,
            contributions: receipt.contributions,
            plugins: receipt.plugins,
            servicesRemoved: receipt.servicesRemoved,
            pending: receipt.pending,
            causes: [...causes, result.failure],
            remediation: "Repair reconciliation state and retry `lando global:reconcile`.",
          }),
        );
    });
    const teardown = yield* Effect.result(resolveGlobalTeardown());
    if (teardown._tag === "Failure") {
      causes.push(teardown.failure);
      yield* pending(
        "evidence",
        pendingWork("evidence", ids, "Applied ownership could not be read; selected cleanup has not run."),
      );
      return { receipt, causes };
    }
    const resolved = teardown.success;
    const online = yield* Effect.result(
      Effect.gen(function* () {
        return (yield* resolved.provider.isAvailable) && (yield* resolved.provider.getStatus).running;
      }),
    );
    if (online._tag === "Failure" || !online.success) {
      if (online._tag === "Failure") causes.push(online.failure);
      yield* pending(
        "evidence",
        pendingWork(
          "evidence",
          ids,
          "The applied provider is unreachable; selected containers and routes are unverified.",
        ),
      );
      return { receipt, causes };
    }
    const inventory = yield* Effect.result(
      resolved.provider.list({ app: AppId.make("global"), includeUnplanned: true }),
    );
    if (inventory._tag === "Failure") {
      causes.push(inventory.failure);
      yield* pending(
        "evidence",
        pendingWork("evidence", ids, "Runtime observations are unavailable; cleanup cannot be confirmed."),
      );
      return { receipt, causes };
    }
    if (resolved.evidence.kind !== "applied") {
      if (resolved.evidence.kind !== "absent") {
        yield* pending(
          "discovery",
          pendingWork(
            "routes",
            ids,
            "Historical routes cannot be verified without a matching applied plan. Restore applied state or explicitly stop the whole global app before retrying.",
          ),
        );
        yield* pending(
          "evidence",
          pendingWork(
            "evidence",
            ids,
            "Runtime resources lack a matching applied plan; ownership and routes need recovery before selected cleanup.",
          ),
        );
      } else {
        if (
          (resolved.materialized && input.routesClearedRevision !== receipt.revision) ||
          input.priorRouteIds.length > 0
        )
          yield* pending(
            "discovery",
            pendingWork(
              "routes",
              ids,
              "Historical routes cannot be verified without a matching applied plan. Restore applied state or explicitly stop the whole global app before retrying.",
            ),
          );
        if (
          inventory.success.some(
            (row) =>
              selected.has(String(row.service)) &&
              (row.appRoot === resolved.paths.root ||
                (row.app === AppId.make("global") && row.appRoot === undefined)),
          )
        )
          yield* pending(
            "evidence",
            pendingWork(
              "evidence",
              ids,
              "Selected runtime observations lack matching applied ownership; cleanup cannot be confirmed until their root and provider evidence are restored.",
            ),
          );
      }
      return { receipt, causes };
    }
    const plan = resolved.evidence.plan;
    const { names, active, blockers, issue } = classifyGlobalCleanupInventory({
      plan,
      root: resolved.paths.root,
      observations: inventory.success,
      candidate: input.candidate,
      selected,
      dependencyBlockers: input.dependencyBlockers,
    });
    if (issue !== undefined) {
      if (blockers.length > 0) causes.push(dependencyError(blockers));
      yield* pending("evidence", pendingWork("evidence", ids, issue));
      return { receipt, causes };
    }
    const appliedIds = ids.filter((id) => names.has(id));
    let routesAttempted = false;
    if (appliedIds.length === 0) {
      if (
        inventory.success.some(
          (row) =>
            selected.has(String(row.service)) &&
            (row.appRoot === resolved.paths.root || (row.app === plan.id && row.appRoot === undefined)),
        )
      )
        yield* pending(
          "evidence",
          pendingWork(
            "evidence",
            ids,
            "Selected resources cannot be matched to the applied plan; cleanup needs ownership recovery.",
          ),
        );
    } else {
      const selection = yield* Effect.result(
        resolveGlobalStopSelection(resolved, appliedIds, {
          requireOnline: true,
          resolution: input.candidate,
        }),
      );
      if (selection._tag === "Failure") {
        causes.push(selection.failure);
        yield* pending(
          "evidence",
          pendingWork("evidence", ids, "Selected owned containers could not be observed."),
        );
      } else {
        const remaining = new Map(
          selection.success.services.map((row) => [row.containerId, String(row.service)]),
        );
        if (remaining.size > 0)
          yield* pending(
            "discovery",
            pendingWork(
              "containers",
              [...new Set(remaining.values())],
              "Selected containers have not all been removed.",
            ),
          );
        if (
          selection.success.routes !== undefined &&
          !receipt.pending.some((entry) => entry.phase === "routes")
        )
          yield* pending(
            "discovery",
            pendingWork("routes", appliedIds, "Selected routes have not yet been withdrawn."),
          );
        yield* persist();
        for (const row of selection.success.services) {
          const removal = yield* Effect.result(resolved.provider.removeObservedService(row));
          if (removal._tag === "Failure") causes.push(removal.failure);
          else {
            remaining.delete(row.containerId);
            if (removal.success.kind === "removed")
              receipt = { ...receipt, servicesRemoved: [...receipt.servicesRemoved, String(row.service)] };
          }
          receipt = {
            ...receipt,
            pending: yield* Effect.fromResult(
              transitionGlobalPending(receipt.pending, "containers", { clears: [{ phase: "containers" }] }),
            ),
          };
          if (remaining.size > 0)
            yield* pending(
              "containers",
              pendingWork(
                "containers",
                [...new Set(remaining.values())],
                "Selected containers could not all be removed.",
              ),
            );
          yield* persist();
        }
        if (selection.success.routePolicyError !== undefined) {
          routesAttempted = true;
          causes.push(selection.success.routePolicyError);
        } else if (selection.success.routes !== undefined) {
          routesAttempted = true;
          const router = yield* RouterService;
          const disabled = new Set(
            input.candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
          );
          const withdrawn = yield* Effect.result(
            router.applyRoutes(
              selection.success.routes.filter((route) => !disabled.has(String(route.service))),
              routeOwnerFromPlan(plan),
            ),
          );
          if (withdrawn._tag === "Failure") causes.push(withdrawn.failure);
          else
            receipt = {
              ...receipt,
              pending: yield* Effect.fromResult(
                transitionGlobalPending(receipt.pending, "routes", { clears: [{ phase: "routes" }] }),
              ),
            };
        }
      }
    }
    if (
      !routesAttempted &&
      input.priorRouteIds.length > 0 &&
      !receipt.pending.some((entry) => entry.phase === "evidence")
    ) {
      const disabled = new Set(
        input.candidate.entries.filter((entry) => !entry.enabled).map((entry) => entry.id),
      );
      const routes = plan.routes.filter(
        (route) =>
          !selected.has(String(route.service)) &&
          !disabled.has(String(route.service)) &&
          active.has(String(route.service)),
      );
      const router = yield* RouterService;
      const withdrawn = yield* Effect.result(router.applyRoutes(routes, routeOwnerFromPlan(plan)));
      if (withdrawn._tag === "Failure") causes.push(withdrawn.failure);
      else
        receipt = {
          ...receipt,
          pending: yield* Effect.fromResult(
            transitionGlobalPending(receipt.pending, "routes", { clears: [{ phase: "routes" }] }),
          ),
        };
    }
    return { receipt, causes };
  },
);
