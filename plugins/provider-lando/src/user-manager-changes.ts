/**
 * Host changes for the systemd user manager the managed runtime launches under: the cgroups
 * delegation drop-in and lingering. A manager that is already running keeps its controllers
 * until a new login, so a drop-in written under it needs one; a manager that starts later (by
 * lingering or the next login) reads the drop-in fresh.
 */
import { createHash } from "node:crypto";

import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import type { HostChange } from "@lando/sdk/schema";
import type { HostChangeProposal } from "@lando/sdk/services";
import { Duration, Effect } from "effect";

import {
  HOST_CHANGE_OWNER,
  SETUP_RERUN,
  changeFailed,
  changeStale,
  privilegedStep,
  runCheckedStep,
} from "./host-change-steps.ts";
import { PREREQUISITE_CHANGES } from "./prerequisite-changes.ts";
import type { UserAccount, UserManagerHost } from "./user-manager.ts";

export const DELEGATE_CONF_DIR = "/etc/systemd/system/user@.service.d";
export const DELEGATE_CONF_PATH = `${DELEGATE_CONF_DIR}/delegate.conf`;
export const DELEGATE_CONF_CONTENT = "[Service]\nDelegate=cpu cpuset io memory pids\n";

const reloadStep = privilegedStep("reload", "Reload systemd", ["/usr/bin/systemctl", "daemon-reload"]);

export const delegationChange = (
  managerRunning: boolean,
  pathExists: (path: string) => boolean,
): HostChangeProposal => {
  const digest = createHash("sha256").update(DELEGATE_CONF_CONTENT).digest("hex");
  const change: HostChange = {
    id: PREREQUISITE_CHANGES.delegation,
    owner: HOST_CHANGE_OWNER,
    stage: "provider",
    summary: "Let your systemd user manager delegate cgroup controllers",
    reason: "Rootless Podman needs cgroups v2 controller delegation for your user session.",
    consent: "standard",
    persistent: false,
    requirement: "required",
    details: { path: DELEGATE_CONF_PATH, sha256: digest },
    // `tee` reads its own descriptor 0 into the fixed root-owned path; opening `/dev/stdin` by
    // path fails on the socket Lando hands a child. Root's umask decides tee's mode, so chmod.
    steps: [
      privilegedStep("create-dir", `Create ${DELEGATE_CONF_DIR}`, [
        "/usr/bin/install",
        "-d",
        "-m",
        "0755",
        DELEGATE_CONF_DIR,
      ]),
      privilegedStep("write", `Write ${DELEGATE_CONF_PATH}`, ["/usr/bin/tee", DELEGATE_CONF_PATH], {
        stdin: { summary: "Delegate=cpu cpuset io memory pids", sha256: digest },
      }),
      privilegedStep("chmod", `Make ${DELEGATE_CONF_PATH} readable`, [
        "/usr/bin/chmod",
        "0644",
        DELEGATE_CONF_PATH,
      ]),
      reloadStep,
    ],
    manual: `sudo install -d -m 0755 '${DELEGATE_CONF_DIR}' && printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | sudo tee '${DELEGATE_CONF_PATH}' >/dev/null && sudo chmod 0644 '${DELEGATE_CONF_PATH}' && sudo systemctl daemon-reload`,
    undo: {
      _tag: "steps",
      consent: "separate",
      summary: `Remove ${DELEGATE_CONF_PATH}`,
      steps: [
        privilegedStep("remove", `Remove ${DELEGATE_CONF_PATH}`, [
          "/usr/bin/rm",
          "-f",
          "--",
          DELEGATE_CONF_PATH,
        ]),
        reloadStep,
      ],
    },
  };
  return {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      if (pathExists(DELEGATE_CONF_PATH)) {
        return yield* Effect.fail(
          changeStale(
            change,
            `${DELEGATE_CONF_PATH} appeared after planning`,
            `${DELEGATE_CONF_PATH} appeared after setup planned it, so Lando left it alone.`,
          ),
        );
      }
      const writeFailed = {
        message: "Failed to write the cgroups delegation drop-in.",
        remediation: `Create ${DELEGATE_CONF_PATH} with \`Delegate=cpu cpuset io memory pids\` under \`[Service]\`, run \`sudo systemctl daemon-reload\`, ${SETUP_RERUN}.`,
      };
      yield* runCheckedStep(steps, change, { id: "create-dir" }, writeFailed);
      yield* runCheckedStep(
        steps,
        change,
        { id: "write", stdin: new TextEncoder().encode(DELEGATE_CONF_CONTENT) },
        writeFailed,
      );
      yield* runCheckedStep(steps, change, { id: "chmod" }, writeFailed);
      yield* runCheckedStep(
        steps,
        change,
        { id: "reload" },
        {
          message: "Wrote the cgroups delegation drop-in, but `systemctl daemon-reload` failed.",
          remediation: `Run \`sudo systemctl daemon-reload\`, log out and back in, ${SETUP_RERUN}.`,
        },
      );
      if (managerRunning) {
        return yield* Effect.fail(
          changeFailed(change, {
            message:
              "Wrote the cgroups delegation drop-in. Your running systemd user manager applies it only after you log out and back in.",
            remediation: `Log out, log back in, ${SETUP_RERUN}.`,
          }),
        );
      }
      return { changed: true, facts: { sha256: digest } };
    }),
  };
};

const defaultManagerWaitPolicy: RetryPolicy = {
  maxAttempts: 60,
  delay: Duration.millis(250),
  timeout: Duration.seconds(20),
};

/**
 * `loginctl enable-linger` asks logind to start the user's manager. Lando waits for its private
 * socket, starts `user@<uid>.service` only when it is still not running, and never restarts one.
 */
export const lingerChange = (
  account: UserAccount,
  userManager: UserManagerHost,
  managerWaitPolicy: RetryPolicy = defaultManagerWaitPolicy,
): HostChangeProposal => {
  const change: HostChange = {
    id: PREREQUISITE_CHANGES.linger,
    owner: HOST_CHANGE_OWNER,
    stage: "provider",
    summary: `Enable lingering for ${account.user}`,
    reason: `No systemd user manager runs for ${account.user}, so Lando's container runtime cannot give containers their own cgroups or apply deploy.resources limits. Enabling lingering starts one without a login session.`,
    consent: "separate",
    optInFlag: "enable-linger",
    persistent: true,
    requirement: "recommended",
    details: { user: account.user, uid: String(account.uid) },
    steps: [
      privilegedStep("enable", "Enable lingering", ["/usr/bin/loginctl", "enable-linger", account.user]),
      privilegedStep(
        "start-manager",
        "Start the user manager",
        ["/usr/bin/systemctl", "start", "--no-block", `user@${account.uid}.service`],
        { when: "if-needed" },
      ),
    ],
    undo: {
      _tag: "steps",
      consent: "separate",
      summary: `Disable lingering for ${account.user}`,
      steps: [
        privilegedStep("disable", "Disable lingering", ["/usr/bin/loginctl", "disable-linger", account.user]),
      ],
    },
  };
  const manual = `Run \`loginctl enable-linger ${account.user}\` yourself, check \`systemctl status user@${account.uid}.service\`, ${SETUP_RERUN}.`;
  const notStarted = {
    message: "Lingering is enabled, but the systemd user manager did not start.",
    remediation: manual,
  };
  const waitForManager = runProbe(
    { id: "provider-lando-user-manager", policy: managerWaitPolicy },
    Effect.suspend(() =>
      userManager.managerRunning(account.uid) ? Effect.void : Effect.fail("user manager socket missing"),
    ),
  ).pipe(
    Effect.map((result) => result.outcome === "green"),
    Effect.catchTag("ProbeError", () => Effect.succeed(false)),
  );
  return {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      if (userManager.managerRunning(account.uid)) return { changed: false };
      yield* runCheckedStep(
        steps,
        change,
        { id: "enable" },
        { message: "Failed to enable lingering.", remediation: manual },
      );
      if (yield* waitForManager) return { changed: true };
      yield* runCheckedStep(steps, change, { id: "start-manager" }, notStarted);
      if (yield* waitForManager) return { changed: true };
      return yield* Effect.fail(changeFailed(change, notStarted));
    }),
  };
};
