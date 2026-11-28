/**
 * One execution-identity selector for commands Lando runs on a user's behalf.
 *
 * Precedence is CLI `--user`, then the tooling step user, then the task user,
 * then the service's realized project user, then the container default. Only a
 * defaulted project user brings its home and `LANDO_USER`/`LANDO_UID`/`LANDO_GID`
 * along: an explicit identity owns its own environment, and a root process keeps
 * the image's home.
 */
import type { AppPlan, ServicePlan, ServiceProjectUser } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

export interface CommandIdentity {
  readonly user?: string;
  readonly environment: Readonly<Record<string, string>>;
}

const HOME_BEARING_HOME_STATES = new Set(["persisted", "authored"]);

/** Environment a user command gets when it runs as the project user. */
export const projectUserEnvironment = (service: ServicePlan): Readonly<Record<string, string>> => {
  const projectUser = service.projectUser;
  if (projectUser === undefined) return {};
  const home = service.home;
  return {
    ...(home !== undefined && HOME_BEARING_HOME_STATES.has(home.state) && "target" in home
      ? { HOME: home.target }
      : {}),
    LANDO_USER: projectUser.name,
    LANDO_UID: String(projectUser.uid),
    LANDO_GID: String(projectUser.gid),
  };
};

export interface SelectCommandIdentityInput {
  /** CLI `--user`; the highest precedence. */
  readonly cliUser?: string | undefined;
  /** Tooling step user. */
  readonly stepUser?: string | undefined;
  /** Tooling task user. */
  readonly taskUser?: string | undefined;
  /**
   * The applied service plan the command actually runs in, or `undefined` when
   * no applied evidence is readable. A missing applied plan keeps the
   * container default so a command never inherits a mapping the container
   * does not realize.
   */
  readonly service?: ServicePlan | undefined;
}

/**
 * The `user` value for an execution that runs as the realized project user.
 * A numeric principal has no passwd entry to supply its authored primary gid,
 * so it names both ids explicitly; a named principal keeps its name.
 */
export const projectUserExecUser = (projectUser: ServiceProjectUser | undefined): string | undefined => {
  if (projectUser === undefined) return undefined;
  return /^[0-9]+$/u.test(projectUser.name) ? `${projectUser.uid}:${projectUser.gid}` : projectUser.name;
};

/**
 * Picks the identity for a user command and the environment that identity
 * implies. Pure: callers pass the applied service plan, never the desired one.
 */
export const selectCommandIdentity = (input: SelectCommandIdentityInput): CommandIdentity => {
  const explicit = input.cliUser ?? input.stepUser ?? input.taskUser;
  if (explicit !== undefined && explicit.length > 0) return { user: explicit, environment: {} };
  const service = input.service;
  if (service === undefined) return { environment: {} };
  const user = projectUserExecUser(service.projectUser);
  if (user === undefined) return { environment: {} };
  return { user, environment: projectUserEnvironment(service) };
};

/**
 * The applied plan recorded for exactly this app root, or `undefined` when none
 * is readable. An enclosing app's plan is never evidence for this one.
 */
export const appliedAppPlan = (
  registry: Context.Service.Shape<typeof RuntimeProviderRegistry>,
  plan: AppPlan,
) =>
  registry
    .readAppliedPlanStrict(plan)
    .pipe(
      Effect.map((recorded) =>
        recorded?.id === plan.id &&
        recorded.provider === plan.provider &&
        (recorded.identity?.appRoot ?? recorded.root) === (plan.identity?.appRoot ?? plan.root)
          ? recorded
          : undefined,
      ),
    );

/**
 * The service plan as it was applied, or `undefined` when no applied plan is
 * readable. Execution defaults must not follow a desired plan that the running
 * container does not realize.
 */
export const appliedServicePlanFrom = (
  applied: AppPlan | undefined,
  serviceName: string,
): ServicePlan | undefined =>
  applied === undefined
    ? undefined
    : Object.values(applied.services).find((service) => String(service.name) === serviceName);

export const appliedServicePlan = (
  registry: Context.Service.Shape<typeof RuntimeProviderRegistry>,
  plan: AppPlan,
  serviceName: string,
) =>
  appliedAppPlan(registry, plan).pipe(Effect.map((applied) => appliedServicePlanFrom(applied, serviceName)));
