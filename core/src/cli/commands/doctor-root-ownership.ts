/**
 * The `lando-roots` doctor section: root-owned entries under Lando's roots, usually left by
 * running Lando with sudo. The section only inspects. On Linux and WSL Lando can give the entries
 * under roots its walker accepts back itself, through the same planned host change setup uses:
 * under `--fix` the section returns that repair as a fix doctor runs after its progress tree, which
 * asks in a terminal (doctor has no `--yes`), opens one administrator session, applies it, and
 * inspects again. A run that cannot ask, such as MCP or a pipe, changes nothing and points at
 * `lando setup --yes`. Every other entry keeps its own manual command: a hard link's removes the
 * link, since giving it back would give away the file it links to.
 */
import { userInfo } from "node:os";

import { homeOfUid } from "@lando/engine/host/account-home";
import { HARD_LINK_REMEDY, type RootOwnedEntry } from "@lando/engine/host/root-ownership";
import {
  FileSystem,
  type HostChangeProposal,
  InteractionService,
  PathsService,
  PrivilegeService,
} from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";

import { landoInvocationPrefix } from "../../recipes/prompts/choices-command";
import { approveHostChanges, askingInteraction } from "../host-changes/approve";
import {
  REPAIR_ROOT_OWNERSHIP,
  type RootOwnershipRepairPlan,
  planRootOwnershipRepair,
} from "../host-changes/root-ownership-change";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding } from "./doctor-contract";
import { type DoctorSectionRun, deferDoctorHostFix } from "./doctor-host-fix";

const CHECK = "root-owned-entries";

export interface RootOwnershipDoctorOptions {
  readonly fix: boolean;
  /** Test seams; production reads the host. */
  readonly platform?: string;
  readonly account?: { readonly user: string; readonly home: string | undefined };
  readonly invocation?: ReadonlyArray<string>;
}

type FixOutcome =
  | { readonly outcome: "recovered" }
  | { readonly outcome: "failed"; readonly error: string }
  | { readonly outcome: "skipped-manual" };

const ASKS = "Run `lando doctor --fix` or `lando setup` (Lando asks before giving these back to you)";

const remedyFor = (entry: RootOwnedEntry, offered: boolean, fix: FixOutcome | undefined): string => {
  if (entry.kind === "hard-link") return HARD_LINK_REMEDY.replace(/:$/u, ".");
  if (!offered) return "Give it back to your user";
  if (fix?.outcome === "skipped-manual") {
    return "This run cannot ask for your approval, so doctor changed nothing. Run `lando setup --yes` to let Lando give it back, or give it back yourself";
  }
  return `${ASKS}, or give it back yourself`;
};

/** The home comes from the same lookup the walker makes as root, so planning and repair agree. */
const hostAccount = (uid: number) => {
  const account = Result.try(() => userInfo());
  return { user: Result.isSuccess(account) ? account.success.username : String(uid), home: homeOfUid(uid) };
};

/** The section's findings for `rootOwned`, after `fix` when doctor ran one. */
const findings = (input: {
  readonly rootOwned: ReadonlyArray<RootOwnedEntry>;
  readonly incomplete: ReadonlyArray<string>;
  readonly repairable: ReadonlySet<string>;
  readonly fix: FixOutcome | undefined;
  readonly redact: (text: string) => string;
}): ReadonlyArray<DoctorFinding> => {
  const { fix, redact } = input;
  const fixContext = fix === undefined ? {} : { fixOutcome: fix.outcome };
  const owned = input.rootOwned.map((entry): DoctorFinding => {
    const offered = entry.kind === "owned" && input.repairable.has(entry.path);
    return failCheck({
      name: CHECK,
      subject: redact(entry.path),
      recovery: offered ? "automatic" : "manual",
      context: {
        path: redact(entry.path),
        ...(entry.kind === "owned" ? {} : { kind: entry.kind }),
        ...(offered ? fixContext : {}),
        ...(offered && fix?.outcome === "failed" ? { fixError: fix.error } : {}),
      },
      solutions: [
        {
          kind: "manual",
          description: redact(
            entry.kind === "unfinished"
              ? entry.remediation
              : `${entry.path} belongs to root, so Lando cannot write it. This usually happens after running lando with sudo. ${remedyFor(entry, offered, fix)}, then run lando without sudo: Lando asks for administrator access itself when a step needs it.`,
          ),
          command: redact(entry.command),
        },
      ],
    });
  });
  const recovered =
    fix?.outcome === "recovered" && !input.rootOwned.some(({ path }) => input.repairable.has(path))
      ? [passCheckNamed({ name: CHECK, recovery: "automatic", context: { fixOutcome: "recovered" } })]
      : [];
  const gaps =
    input.incomplete.length === 0
      ? []
      : [
          warnCheck({
            name: CHECK,
            recovery: "manual",
            context: { incomplete: input.incomplete.map(redact) },
            solutions: [
              {
                kind: "manual",
                description: redact(
                  `Doctor could not inspect every Lando file for root ownership (${input.incomplete.join("; ")}). Check these paths yourself, or rerun lando doctor.`,
                ),
              },
            ],
          }),
        ];
  const all = [...recovered, ...owned, ...gaps];
  return all.length > 0 ? all : [passCheckNamed({ name: CHECK, context: {} })];
};

/** Ask, give the repairable entries back, and report what is still root-owned afterwards. */
const runFix = Effect.fnUntraced(function* (
  plan: RootOwnershipRepairPlan,
  proposal: HostChangeProposal,
  redact: (text: string) => string,
) {
  const repairable = new Set(plan.repairable.map(({ path }) => path));
  const settle = (fix: FixOutcome, scan = plan.scan) =>
    findings({ rootOwned: scan.rootOwned, incomplete: scan.incomplete, repairable, fix, redact });
  const interaction = yield* askingInteraction(
    Option.getOrUndefined(yield* Effect.serviceOption(InteractionService)),
    false,
  );
  if (interaction === undefined) return settle({ outcome: "skipped-manual" });
  const applied = yield* Effect.scoped(
    Effect.gen(function* () {
      // Doctor has no `--yes`: the repair runs only after a terminal answer.
      const run = yield* approveHostChanges({
        command: "doctor",
        proposals: [proposal],
        yes: false,
        optInFlags: new Set(),
        interaction,
        privilege: Option.getOrUndefined(yield* Effect.serviceOption(PrivilegeService)),
      });
      return yield* run.applier.apply(REPAIR_ROOT_OWNERSHIP);
    }),
  ).pipe(Effect.result);
  if (Result.isFailure(applied)) return settle({ outcome: "failed", error: redact(applied.failure.message) });
  const after = yield* plan.remaining;
  const left = after.rootOwned.filter(({ path }) => repairable.has(path));
  const fix: FixOutcome =
    left.length === 0
      ? { outcome: "recovered" }
      : {
          outcome: "failed",
          error: redact(`${left.map(({ path }) => path).join(", ")} still belong to root.`),
        };
  return settle(fix, after);
});

/** Reports root-owned entries under Lando's roots, usually left by running Lando with sudo. */
export const rootOwnershipDoctor = Effect.fnUntraced(function* (
  redact: (text: string) => string,
  options: RootOwnershipDoctorOptions = { fix: false },
): Effect.fn.Return<DoctorSectionRun, never, PathsService | FileSystem> {
  const paths = yield* PathsService;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return { checks: [] };
  const account = options.account ?? hostAccount(uid);
  const plan = yield* planRootOwnershipRepair({
    paths,
    uid,
    gid,
    user: account.user,
    platform: options.platform ?? process.platform,
    home: account.home,
    invocation: options.invocation ?? landoInvocationPrefix(process.execPath, process.argv),
  });
  const checks = findings({
    rootOwned: plan.scan.rootOwned,
    incomplete: plan.scan.incomplete,
    repairable: new Set(plan.repairable.map(({ path }) => path)),
    fix: undefined,
    redact,
  });
  if (!options.fix || plan.proposal === undefined) return { checks };
  // The repair asks and may need sudo, so doctor runs it after its progress tree has finished.
  const fileSystem = yield* FileSystem;
  const fix = runFix(plan, plan.proposal, redact).pipe(Effect.provideService(FileSystem, fileSystem));
  return { checks, fixes: [yield* deferDoctorHostFix(CHECK, fix)] };
});
