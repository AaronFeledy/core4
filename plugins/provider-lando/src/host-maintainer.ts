/**
 * Uninstall steps for the host changes the managed provider's setup makes on Linux: lingering, the
 * cgroups delegation drop-in, and subordinate UID and GID ranges. A recorded change is undone only
 * when the host still shows exactly what setup recorded: the linger flag file for the recorded
 * user, a drop-in whose content digest equals the receipt's, or the exact range line. Each step
 * declares the recorded undo commands, so `lando uninstall --purge --undo <id>` runs them through
 * the uninstall's one administrator session; uninstall rechecks the same proof before it runs
 * anything. A drop-in Lando has no record of keeps today's manual instructions; lingering Lando
 * has no record of is not Lando's to touch.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isErrnoCode } from "@lando/sdk/errors";
import type { HostMaintenanceContribution, HostUninstallInput } from "@lando/sdk/plugins";
import {
  type HostChangeReceipt,
  type HostUninstallOutcome,
  type HostUninstallStep,
  receiptUndoChange,
} from "@lando/sdk/schema";
import type { HostChangeStepRunner } from "@lando/sdk/services";
import { Effect } from "effect";

import { PREREQUISITE_CHANGES } from "./prerequisite-changes.ts";
import { parseSubordinateIdFile } from "./rootless-preflight.ts";
import { DELEGATE_CONF_PATH } from "./user-manager-changes.ts";

const PROVIDER_HOST_MAINTAINER_ID = "provider-lando";

export const lingerFlagPath = (user: string): string => `/var/lib/systemd/linger/${user}`;

export interface ProviderHostAccess {
  readonly exists: (path: string) => boolean;
  /** File text, or `undefined` when the file does not exist. Other read errors throw. */
  readonly readText: (path: string) => string | undefined;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** Whether the host still shows what the receipt recorded, and why not when it does not. */
type Proof =
  | { readonly holds: true }
  | { readonly holds: false; readonly gone: boolean; readonly why: string };

const holds: Proof = { holds: true };
const gone = (why: string): Proof => ({ holds: false, gone: true, why });
const differs = (why: string): Proof => ({ holds: false, gone: false, why });

const proveLinger = (host: ProviderHostAccess, receipt: HostChangeReceipt): Proof => {
  const user = receipt.facts?.user;
  if (user === undefined) return differs("the record does not name the user");
  return host.exists(lingerFlagPath(user)) ? holds : gone(`Lingering is already disabled for ${user}.`);
};

const proveDropIn = (host: ProviderHostAccess, receipt: HostChangeReceipt): Proof => {
  const content = host.readText(DELEGATE_CONF_PATH);
  if (content === undefined) return gone(`${DELEGATE_CONF_PATH} is already gone.`);
  const recorded = receipt.facts?.sha256;
  return recorded !== undefined && sha256(content) === recorded
    ? holds
    : differs(`${DELEGATE_CONF_PATH} changed since Lando wrote it, so Lando leaves it alone.`);
};

const proveRange = (host: ProviderHostAccess, receipt: HostChangeReceipt): Proof => {
  const { file, range, user } = receipt.facts ?? {};
  const [first, last] = (range ?? "").split("-").map(Number);
  if (file === undefined || user === undefined || first === undefined || last === undefined) {
    return differs("the record does not name the file, user, and range");
  }
  const text = host.readText(file);
  const present = parseSubordinateIdFile(text ?? "").some(
    (entry) => entry.user === user && entry.start === first && entry.count === last - first + 1,
  );
  return present ? holds : gone(`${file} no longer holds ${user}:${first}:${last - first + 1}.`);
};

interface RecordedChange {
  readonly id: string;
  readonly label: string;
  readonly target: (receipt: HostChangeReceipt) => string;
  readonly prove: (host: ProviderHostAccess, receipt: HostChangeReceipt) => Proof;
}

const RECORDED: ReadonlyArray<RecordedChange> = [
  {
    id: PREREQUISITE_CHANGES.linger,
    label: "lingering",
    target: (receipt) => lingerFlagPath(receipt.facts?.user ?? "<user>"),
    prove: proveLinger,
  },
  {
    id: PREREQUISITE_CHANGES.delegation,
    label: "cgroups delegation drop-in",
    target: () => DELEGATE_CONF_PATH,
    prove: proveDropIn,
  },
  {
    id: PREREQUISITE_CHANGES.subuids,
    label: "subordinate user IDs",
    target: (receipt) => receipt.facts?.file ?? "/etc/subuid",
    prove: proveRange,
  },
  {
    id: PREREQUISITE_CHANGES.subgids,
    label: "subordinate group IDs",
    target: (receipt) => receipt.facts?.file ?? "/etc/subgid",
    prove: proveRange,
  },
];

const stepId = (changeId: string): string => changeId.slice(changeId.indexOf(":") + 1);

const UNRECORDED_DROP_IN_DETAIL = `This system-wide drop-in is not recorded as owned by this installation. If no other installation or program needs it, run \`sudo rm -- ${shellQuote(DELEGATE_CONF_PATH)}\` and then \`sudo systemctl daemon-reload\`.`;

const recordedStep = (
  host: ProviderHostAccess,
  recorded: RecordedChange,
  receipt: HostChangeReceipt,
): HostUninstallStep => {
  const base = {
    id: stepId(recorded.id),
    label: recorded.label,
    target: recorded.target(receipt),
    destructive: true,
    receiptId: receipt.id,
    // The apps that --keep-data leaves in place still run under these settings.
    preserveOnKeepData: true,
  };
  const proof = recorded.prove(host, receipt);
  const change = receiptUndoChange(receipt, "provider");
  if (!proof.holds) return { ...base, status: proof.gone ? "skipped" : "manual", detail: proof.why };
  if (change === undefined) {
    return {
      ...base,
      status: "manual",
      detail: receipt.undo._tag === "manual" ? receipt.undo.detail : "Lando recorded nothing to undo.",
    };
  }
  return { ...base, status: "owned", detail: `${change.summary}, which Lando's setup recorded.`, change };
};

/** The drop-in without a record: someone else's, or an older Lando's; either way manual. */
const unrecordedDropIn = (host: ProviderHostAccess): ReadonlyArray<HostUninstallStep> =>
  host.exists(DELEGATE_CONF_PATH)
    ? [
        {
          id: stepId(PREREQUISITE_CHANGES.delegation),
          label: "cgroups delegation drop-in",
          target: DELEGATE_CONF_PATH,
          destructive: false,
          status: "manual",
          detail: UNRECORDED_DROP_IN_DETAIL,
        },
      ]
    : [];

const runDeclaredSteps = Effect.fnUntraced(function* (
  run: HostChangeStepRunner,
  step: HostUninstallStep,
): Effect.fn.Return<HostUninstallOutcome> {
  for (const declared of step.change?.steps ?? []) {
    const ran = yield* Effect.result(run.run(declared.id));
    if (ran._tag === "Failure") {
      return { outcome: "failed", error: `${ran.failure.message} ${ran.failure.remediation}` };
    }
    if (ran.success.exitCode !== 0) {
      const stderr = ran.success.stderr.trim();
      return {
        outcome: "failed",
        error: `\`${declared.argv.join(" ")}\` exited ${ran.success.exitCode}${stderr.length === 0 ? "" : `: ${stderr}`}`,
      };
    }
  }
  return { outcome: "completed", ...(step.change === undefined ? {} : { detail: step.change.summary }) };
});

export const makeProviderHostMaintainer = (
  access: Partial<ProviderHostAccess> = {},
): HostMaintenanceContribution => {
  const host: ProviderHostAccess = {
    exists: access.exists ?? existsSync,
    readText: access.readText ?? readText,
  };
  const linux = (input: HostUninstallInput) => input.platform === "linux" || input.platform === "wsl";

  const plan = Effect.fn("ProviderHostMaintainer.plan")(function* (input: HostUninstallInput) {
    if (!linux(input)) return [];
    return yield* Effect.sync(() => {
      const steps = RECORDED.flatMap((recorded) => {
        const receipt = input.receipts.find(({ id }) => id === recorded.id);
        return receipt === undefined ? [] : [recordedStep(host, recorded, receipt)];
      });
      const dropInRecorded = input.receipts.some(({ id }) => id === PREREQUISITE_CHANGES.delegation);
      return dropInRecorded ? steps : [...steps, ...unrecordedDropIn(host)];
    });
  });

  const execute: NonNullable<HostMaintenanceContribution["uninstall"]>["execute"] = Effect.fn(
    "ProviderHostMaintainer.execute",
  )(function* (input) {
    const recorded = RECORDED.find(({ id }) => stepId(id) === input.step.id);
    const receipt = input.receipts.find(({ id }) => id === input.step.receiptId);
    if (recorded === undefined || receipt === undefined) {
      return { outcome: "manual", detail: input.step.detail };
    }
    // The host may have changed since the plan; act only on the same proof.
    const proof = yield* Effect.sync(() => recorded.prove(host, receipt));
    if (!proof.holds)
      return proof.gone
        ? { outcome: "skipped", detail: proof.why }
        : { outcome: "manual", detail: proof.why };
    if (input.run === undefined || input.step.change === undefined) {
      const commands = (input.step.change?.steps ?? []).map(
        ({ argv }) => `\`sudo ${argv.map(shellQuote).join(" ")}\``,
      );
      return {
        outcome: "manual",
        detail: `Lando has no administrator session to undo this; run ${commands.join(", then ")}.`,
      };
    }
    return yield* runDeclaredSteps(input.run, input.step);
  });

  return { id: PROVIDER_HOST_MAINTAINER_ID, uninstall: { plan, execute } };
};
