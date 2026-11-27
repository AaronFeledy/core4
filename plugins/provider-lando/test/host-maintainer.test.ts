import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { HostUninstallInput } from "@lando/sdk/plugins";
import {
  HostChangeId,
  type HostChangeReceipt,
  type HostPlatform,
  type HostUninstallStep,
} from "@lando/sdk/schema";
import type { HostChangeStepRunner } from "@lando/sdk/services";
import { Effect } from "effect";

import { lingerFlagPath, makeProviderHostMaintainer } from "../src/host-maintainer.ts";
import {
  DELEGATE_CONF_CONTENT,
  DELEGATE_CONF_PATH,
  delegationChange,
  lingerChange,
} from "../src/user-manager-changes.ts";

const digest = createHash("sha256").update(DELEGATE_CONF_CONTENT).digest("hex");

/** The receipt setup's applier records for a change: its details, the apply facts, and its undo. */
const recorded = (
  change: {
    readonly id: string;
    readonly summary: string;
    readonly details?: Readonly<Record<string, string>>;
  },
  undo: HostChangeReceipt["undo"],
  facts: Readonly<Record<string, string>> = {},
): HostChangeReceipt => ({
  id: HostChangeId.make(change.id),
  owner: "@lando/provider-lando",
  summary: change.summary,
  phase: "applied",
  startedAt: "2026-11-26T00:00:00.000Z",
  appliedAt: "2026-11-26T00:00:01.000Z",
  facts: { ...change.details, ...facts },
  undo,
});

const account = { user: "dev", uid: 1000 };
const linger = lingerChange(account, {
  account: () => account,
  managerRunning: () => false,
  showUnit: () =>
    Effect.succeed({ _tag: "known", loadState: "loaded", delegateControllers: new Set<string>() }),
  pathExists: () => false,
}).change;
const dropIn = delegationChange(false, () => false).change;
const LINGER = recorded(linger, linger.undo);
const DROP_IN = recorded(dropIn, dropIn.undo, { sha256: digest });
const SUBUIDS = recorded(
  {
    id: "provider-lando:add-subuids",
    summary: "Add subordinate user IDs",
    details: { file: "/etc/subuid", range: "100000-165535", user: "dev" },
  },
  {
    _tag: "steps",
    consent: "separate",
    summary: "Remove subordinate user IDs 100000-165535 for dev",
    steps: [
      {
        id: "remove",
        summary: "remove",
        argv: ["/usr/sbin/usermod", "--del-subuids", "100000-165535", "dev"],
        privileged: true,
        when: "always",
      },
    ],
  },
);

const host = (files: Readonly<Record<string, string>>) => {
  const state = new Map(Object.entries(files));
  return {
    state,
    maintainer: makeProviderHostMaintainer({
      exists: (path) => state.has(path),
      readText: (path) => state.get(path),
    }),
  };
};

const plan = (
  maintainer: ReturnType<typeof makeProviderHostMaintainer>,
  receipts: ReadonlyArray<HostChangeReceipt>,
  platform: HostPlatform = "linux",
) => {
  const input: HostUninstallInput = { platform, userDataRoot: "/lando", receipts };
  return Effect.runPromise(maintainer.uninstall?.plan(input) ?? Effect.succeed([]));
};

const recordingRunner = () => {
  const ran: string[] = [];
  const run: HostChangeStepRunner = {
    run: (id) =>
      Effect.sync(() => {
        ran.push(id);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  };
  return { run, ran };
};

const execute = (
  maintainer: ReturnType<typeof makeProviderHostMaintainer>,
  receipts: ReadonlyArray<HostChangeReceipt>,
  step: HostUninstallStep,
  run?: HostChangeStepRunner,
) =>
  Effect.runPromise(
    maintainer.uninstall?.execute({
      platform: "linux",
      userDataRoot: "/lando",
      receipts,
      step,
      ...(run === undefined ? {} : { run }),
    }) ?? Effect.die("no uninstall"),
  );

describe("the managed provider's uninstall steps", () => {
  test("plan the recorded undo only while the host still shows exactly what setup recorded", async () => {
    const { maintainer } = host({
      [lingerFlagPath("dev")]: "",
      [DELEGATE_CONF_PATH]: DELEGATE_CONF_CONTENT,
      "/etc/subuid": "dev:100000:65536\n",
    });

    const steps = await plan(maintainer, [LINGER, DROP_IN, SUBUIDS]);

    expect(
      steps.map(({ id, status, receiptId, preserveOnKeepData }) => ({
        id,
        status,
        receiptId,
        preserveOnKeepData,
      })),
    ).toEqual([
      { id: "enable-linger", status: "owned", receiptId: LINGER.id, preserveOnKeepData: true },
      { id: "delegate-cgroups", status: "owned", receiptId: DROP_IN.id, preserveOnKeepData: true },
      { id: "add-subuids", status: "owned", receiptId: SUBUIDS.id, preserveOnKeepData: true },
    ]);
    expect(steps.map(({ change }) => change?.consent)).toEqual(["separate", "separate", "separate"]);
    expect(steps[0]?.change?.steps.map(({ argv }) => argv)).toEqual([
      ["/usr/bin/loginctl", "disable-linger", "dev"],
    ]);
  });

  test.each([
    ["a drop-in someone edited", { [DELEGATE_CONF_PATH]: "[Service]\nDelegate=cpu\n" }, DROP_IN, "manual"],
    ["a drop-in already removed", {}, DROP_IN, "skipped"],
    ["lingering already disabled", {}, LINGER, "skipped"],
    ["a range someone changed", { "/etc/subuid": "dev:100000:1000\n" }, SUBUIDS, "skipped"],
  ] as const)("leave %s alone", async (_name, files, receipt, status) => {
    const steps = await plan(host(files).maintainer, [receipt]);

    expect(steps.map((step) => [step.status, step.change])).toEqual([[status, undefined]]);
  });

  test("a drop-in without a record keeps today's manual instructions; lingering without one is not Lando's", async () => {
    const { maintainer } = host({ [DELEGATE_CONF_PATH]: DELEGATE_CONF_CONTENT, [lingerFlagPath("dev")]: "" });

    const steps = await plan(maintainer, []);

    expect(steps.map(({ id, status }) => [id, status])).toEqual([["delegate-cgroups", "manual"]]);
    expect(steps[0]?.detail).toContain("sudo systemctl daemon-reload");
  });

  test("never reads the host outside Linux and WSL", async () => {
    const maintainer = makeProviderHostMaintainer({
      exists: () => {
        throw new Error("unexpected IO");
      },
      readText: () => {
        throw new Error("unexpected IO");
      },
    });

    expect(await plan(maintainer, [LINGER, DROP_IN], "darwin")).toEqual([]);
  });

  test("execute rechecks the proof and runs only the declared undo steps", async () => {
    const { maintainer, state } = host({ [DELEGATE_CONF_PATH]: DELEGATE_CONF_CONTENT });
    const [step] = await plan(maintainer, [DROP_IN]);
    if (step === undefined) throw new Error("expected a drop-in step");
    const { run, ran } = recordingRunner();

    expect(await execute(maintainer, [DROP_IN], step, run)).toMatchObject({ outcome: "completed" });
    expect(ran).toEqual(["remove", "reload"]);

    state.set(DELEGATE_CONF_PATH, "[Service]\nDelegate=cpu\n");
    const changed = recordingRunner();
    expect(await execute(maintainer, [DROP_IN], step, changed.run)).toMatchObject({ outcome: "manual" });
    expect(changed.ran).toEqual([]);
  });

  test("a failed undo step reports the command, and no session means manual commands", async () => {
    const { maintainer } = host({ [lingerFlagPath("dev")]: "" });
    const [step] = await plan(maintainer, [LINGER]);
    if (step === undefined) throw new Error("expected a linger step");
    const refusing: HostChangeStepRunner = {
      run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "Access denied" }),
    };

    expect(await execute(maintainer, [LINGER], step, refusing)).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("Access denied"),
    });
    expect(await execute(maintainer, [LINGER], step)).toMatchObject({
      outcome: "manual",
      detail: expect.stringContaining("`sudo /usr/bin/loginctl disable-linger dev`"),
    });
  });
});
