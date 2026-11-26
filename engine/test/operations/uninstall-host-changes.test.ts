import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";

import { HostChangeFailedError, PrivilegeCredentialsRequiredError } from "@lando/sdk/errors";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import {
  HostChangeId,
  type HostChangeReceipt,
  type HostChangeUndo,
  type HostUninstallStep,
  receiptUndoChange,
} from "@lando/sdk/schema";
import { PrivilegeService } from "@lando/sdk/services";
import { makeTestPrivilegeService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Cause, Effect, Exit, Layer } from "effect";

import { type HostChangeReceiptStore, makeHostChangeReceiptStore } from "../../src/host-changes/receipts.ts";
import { type UninstallOptions, uninstall } from "../../src/operations/uninstall.ts";
import {
  UninstallUndoNeedsPurgeError,
  UninstallUndoUnavailableError,
  UninstallUndoUnknownError,
  gateContributedUndo,
  planUnlistedReceiptSteps,
  validateUndoSelection,
} from "../../src/operations/uninstall-host-changes.ts";
import { HostMaintenanceRegistry } from "../../src/runtime/host-maintenance.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

const OWNER = "@lando/provider-test";

const steps = (
  consent: "standard" | "separate",
  argv: readonly [string, ...string[]],
  summary = `Run ${argv[0]}`,
): HostChangeUndo => ({
  _tag: "steps",
  consent,
  summary,
  steps: [{ id: "undo", summary: "Undo", argv, privileged: true, when: "always" }],
});

const receipt = (id: string, undo: HostChangeUndo, owner = OWNER): HostChangeReceipt => ({
  id: HostChangeId.make(id),
  owner,
  summary: `Change ${id}`,
  phase: "applied",
  startedAt: "2026-11-26T00:00:00.000Z",
  undo,
});

const LINGER = receipt(
  "provider-test:enable-linger",
  steps("separate", ["/usr/bin/loginctl", "disable-linger", "dev"]),
);

const seeded = async (...receipts: ReadonlyArray<HostChangeReceipt>): Promise<HostChangeReceiptStore> => {
  const store = makeHostChangeReceiptStore(makeTestStateStore().service);
  for (const { phase: _phase, ...recorded } of receipts) {
    await Effect.runPromise(store.write({ operation: "begin-apply", receipt: recorded }));
    await Effect.runPromise(store.write({ operation: "record-applied", receipt: recorded }));
  }
  return store;
};

/** A maintainer that proves nothing beyond the receipt and plans exactly its recorded undo. */
const recordingMaintainer = (seen: HostChangeReceipt[][] = []): HostMaintenanceContribution => ({
  id: "provider-test",
  uninstall: {
    plan: ({ receipts }) =>
      Effect.sync(() => {
        seen.push([...receipts]);
        return receipts.flatMap((recorded): HostUninstallStep[] => {
          const change = receiptUndoChange(recorded, "provider");
          return change === undefined
            ? []
            : [
                {
                  id: String(recorded.id).split(":")[1] ?? "undo",
                  label: recorded.summary,
                  target: String(recorded.id),
                  destructive: true,
                  status: "owned",
                  detail: change.summary,
                  receiptId: recorded.id,
                  change,
                },
              ];
        });
      }),
    execute: ({ step, run }) =>
      Effect.gen(function* () {
        if (run === undefined) return { outcome: "manual" as const, detail: "no session" };
        for (const declared of step.change?.steps ?? []) {
          const ran = yield* Effect.orDie(run.run(declared.id));
          if (ran.exitCode !== 0) return { outcome: "failed" as const, error: ran.stderr };
        }
        return { outcome: "completed" as const };
      }),
  },
});

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const found = Cause.findErrorOption(exit.cause);
  if (found._tag !== "Some") throw new Error("expected a tagged failure");
  return found.value;
};

const run = (options: UninstallOptions, maintainers: ReadonlyArray<HostMaintenanceContribution>) =>
  uninstall(options).pipe(
    Effect.provide(PrivateFileAccessService.layer),
    Effect.provide(
      Layer.succeed(
        HostMaintenanceRegistry,
        HostMaintenanceRegistry.of({
          maintainers: maintainers.map((maintainer) => ({ ...maintainer, pluginId: OWNER })),
        }),
      ),
    ),
  );

describe("consent for a maintainer's recorded undo", () => {
  const change = receiptUndoChange(LINGER, "provider");
  if (change === undefined) throw new Error("expected undo steps");
  const step: HostUninstallStep = {
    id: "enable-linger",
    label: "lingering",
    target: "/var/lib/systemd/linger/dev",
    destructive: true,
    status: "owned",
    detail: "Disable lingering.",
    receiptId: LINGER.id,
    change,
  };

  test("a separate undo runs only when --undo names it, and otherwise prints its exact commands", () => {
    const unnamed = gateContributedUndo(step, []);
    expect(unnamed.status).toBe("manual");
    expect(unnamed.detail).toContain("`--purge --undo provider-test:enable-linger`");
    expect(unnamed.detail).toContain("`sudo /usr/bin/loginctl disable-linger dev`");
    expect(gateContributedUndo(step, ["provider-test:enable-linger"]).status).toBe("owned");
    expect(gateContributedUndo(step, ["all"]).status).toBe("owned");
  });

  test("a standard undo runs with --purge alone", () => {
    expect(gateContributedUndo({ ...step, change: { ...change, consent: "standard" } }, []).status).toBe(
      "owned",
    );
  });

  test("--undo naming a change Lando did not record fails and lists the ones it can undo", async () => {
    const error = failureOf(
      await Effect.runPromiseExit(validateUndoSelection([LINGER], ["provider-test:nope"], "purge")),
    );

    expect(error).toBeInstanceOf(UninstallUndoUnknownError);
    expect(error).toMatchObject({ unknown: ["provider-test:nope"], known: ["provider-test:enable-linger"] });
  });

  test("--undo without --purge refuses, naming --purge, because --keep-data keeps every change", async () => {
    const error = failureOf(
      await Effect.runPromiseExit(
        validateUndoSelection([LINGER], ["provider-test:enable-linger"], "keep-data"),
      ),
    );

    expect(error).toBeInstanceOf(UninstallUndoNeedsPurgeError);
    expect(Reflect.get(Object(error), "remediation")).toContain(
      "`--purge --undo provider-test:enable-linger`",
    );
  });
});

describe("receipts no maintainer lists", () => {
  test("are listed under their own id as manual steps with what setup recorded, and kept by --keep-data", () => {
    const orphan = receipt(
      "third-party:tweak",
      steps("separate", ["/usr/bin/true", "undo"]),
      "@lando/third-party",
    );
    const shared = receipt("provider-test:install-uidmap", {
      _tag: "manual",
      detail: "uidmap is a shared system package. Remove it only if nothing else needs it.",
    });
    const plan = (mode: "purge" | "keep-data") =>
      planUnlistedReceiptSteps([LINGER, orphan, shared], { mode, listed: new Set([String(LINGER.id)]) });

    expect(plan("purge").map(({ id, status }) => [id, status])).toEqual([
      ["third-party:tweak", "manual"],
      ["provider-test:install-uidmap", "manual"],
    ]);
    expect(plan("purge")[0]?.detail).toContain("`sudo /usr/bin/true undo`");
    expect(plan("purge")[1]?.detail).toBe(
      "Setup recorded `provider-test:install-uidmap`; Lando does not undo it. uidmap is a shared system package. Remove it only if nothing else needs it.",
    );
    expect(plan("keep-data").map(({ status }) => status)).toEqual(["skipped", "skipped"]);
  });
});

describe("undoing recorded host changes", () => {
  const purge = async (receipts: HostChangeReceiptStore, extra: UninstallOptions = {}) => {
    const roots = makeUninstallRoots("lando-uninstall-undo-");
    mkdirSync(roots.userDataRoot, { recursive: true });
    const elevated: string[] = [];
    const seen: HostChangeReceipt[][] = [];
    const exit = await Effect.runPromiseExit(
      run(
        sandboxUninstallOptions(roots, {
          purge: true,
          yes: true,
          hostChangeReceipts: receipts,
          elevate: async (command) => {
            elevated.push(command.join(" "));
            return { exitCode: command.includes("fail") ? 1 : 0, stderr: "refused" };
          },
          ...extra,
        }),
        [recordingMaintainer(seen)],
      ),
    );
    return { exit, elevated, roots, seen };
  };

  test("hands each maintainer its plugin's receipts, runs the named undo, and forgets the receipt", async () => {
    const other = receipt("other:thing", steps("separate", ["/usr/bin/true"]), "@lando/other");
    const receipts = await seeded(LINGER, other);

    const { exit, elevated, seen } = await purge(receipts, { undo: ["provider-test:enable-linger"] });

    if (!Exit.isSuccess(exit)) throw new Error("expected uninstall to finish");
    expect(seen.flat().map(({ id }) => String(id))).toEqual(["provider-test:enable-linger"]);
    expect(exit.value.steps.find(({ id }) => id === "provider-test:enable-linger")).toMatchObject({
      outcome: "completed",
    });
    expect(elevated).toEqual(["/usr/bin/loginctl disable-linger dev"]);
    expect((await Effect.runPromise(receipts.list)).map(({ id }) => String(id))).toEqual(["other:thing"]);
  });

  test("a failed undo keeps its receipt and the data root that holds it", async () => {
    const broken = receipt("provider-test:add-subuids", steps("separate", ["/usr/sbin/usermod", "fail"]));
    const receipts = await seeded(broken);

    const { exit, roots } = await purge(receipts, { undo: ["all"] });

    if (!Exit.isSuccess(exit)) throw new Error("expected a result");
    expect(exit.value.failed).toBe(true);
    expect(exit.value.steps.find(({ id }) => id === "provider-test:add-subuids")).toMatchObject({
      outcome: "failed",
    });
    expect((await Effect.runPromise(receipts.list)).map(({ phase }) => phase)).toEqual(["applied"]);
    expect(existsSync(roots.userDataRoot)).toBe(true);
  });

  test("--undo without --purge refuses before anything changes", async () => {
    const { exit, elevated, roots } = await purge(await seeded(LINGER), {
      purge: false,
      keepData: true,
      undo: ["all"],
    });

    expect(failureOf(exit)).toBeInstanceOf(UninstallUndoNeedsPurgeError);
    expect(elevated).toEqual([]);
    expect(existsSync(roots.userDataRoot)).toBe(true);
  });

  test("a recorded change its maintainer does not plan is still listed, under its own id", async () => {
    const shared = receipt("provider-test:install-uidmap", {
      _tag: "manual",
      detail: "uidmap is a shared system package.",
    });

    const { exit, elevated } = await purge(await seeded(shared), { dryRun: true });

    if (!Exit.isSuccess(exit)) throw new Error("expected a plan");
    expect(exit.value.steps.find(({ id }) => id === "provider-test:install-uidmap")).toMatchObject({
      status: "manual",
    });
    expect(elevated).toEqual([]);
  });

  describe("receipts that cannot be read", () => {
    const unreadable: HostChangeReceiptStore = {
      list: Effect.fail(
        new HostChangeFailedError({
          changeId: "host-change:receipts",
          message:
            "Lando could not read its host-change receipts: the record is truncated (API_TOKEN=abc123)",
          remediation: "Move the file aside.",
        }),
      ),
      write: () => Effect.die("nothing may be undone without a readable record"),
    };

    test("the plan still runs, with a manual step naming the file and the redacted error", async () => {
      const { exit, roots } = await purge(unreadable, { dryRun: true });

      if (!Exit.isSuccess(exit)) throw new Error(`expected a plan: ${String(exit)}`);
      const step = exit.value.steps.find(({ id }) => id === "host-change-receipts");
      expect(step).toMatchObject({ status: "manual", target: `${roots.userDataRoot}/host-changes/receipts` });
      expect(step?.detail).toContain("the record is truncated");
      expect(step?.detail).not.toContain("abc123");
    });

    test("--undo is refused with that reason before anything changes", async () => {
      const { exit, elevated, roots } = await purge(unreadable, { undo: ["all"] });

      expect(failureOf(exit)).toBeInstanceOf(UninstallUndoUnavailableError);
      expect(elevated).toEqual([]);
      expect(existsSync(roots.userDataRoot)).toBe(true);
    });

    test("--purge still removes the data root that holds the unreadable record", async () => {
      const { exit, roots } = await purge(unreadable);

      if (!Exit.isSuccess(exit)) throw new Error(`expected uninstall to finish: ${String(exit)}`);
      expect(existsSync(roots.userDataRoot)).toBe(false);
    });
  });

  test("an unknown --undo id refuses before anything changes", async () => {
    const { exit, elevated, roots } = await purge(await seeded(LINGER), { undo: ["provider-test:nope"] });

    expect(failureOf(exit)).toBeInstanceOf(UninstallUndoUnknownError);
    expect(elevated).toEqual([]);
    expect(existsSync(roots.userDataRoot)).toBe(true);
  });

  test("privileged undo opens one session first; a run without credentials changes nothing", async () => {
    const roots = makeUninstallRoots("lando-uninstall-session-");
    mkdirSync(roots.userDataRoot, { recursive: true });
    const denied = new PrivilegeCredentialsRequiredError({
      purpose: "undo",
      message: "sudo needs a password",
      remediation: "Run `sudo -v` first.",
    });
    const purposes: string[] = [];
    const privilege = makeTestPrivilegeService({
      elevate: () => Effect.die("no command may run without a session"),
      open: (purpose) =>
        Effect.sync(() => void purposes.push(purpose)).pipe(Effect.andThen(Effect.fail(denied))),
    });

    const exit = await Effect.runPromiseExit(
      run(
        sandboxUninstallOptions(roots, {
          purge: true,
          yes: true,
          undo: ["all"],
          hostChangeReceipts: await seeded(
            { ...LINGER, undo: steps("separate", ["/usr/bin/loginctl"], "Disable lingering for dev") },
            receipt(
              "provider-test:trust-ca",
              steps("standard", ["/usr/bin/rm"], "Remove Lando's local CA from the system store"),
            ),
          ),
        }),
        [recordingMaintainer()],
      ).pipe(Effect.provideService(PrivilegeService, privilege)),
    );

    expect(failureOf(exit)).toBe(denied);
    // The announcement reads "Lando needs administrator access to <purpose>."
    expect(purposes).toEqual(["disable lingering for dev and remove Lando's local CA from the system store"]);
    expect(existsSync(roots.userDataRoot)).toBe(true);
  });
});
