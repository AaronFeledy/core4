import { PhpMyAdminHostsCredsError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { AppFeatureServiceView } from "@lando/sdk/services";

export type PmaCreds = {
  readonly user: string;
  readonly password: string;
};

const DEFAULT_CREDS: PmaCreds = { user: "lando", password: "lando" };

export const authoredPmaCreds = (config: ServiceConfig): PmaCreds | undefined => {
  const user = config.creds?.user;
  const password = config.creds?.password;
  if (user !== undefined && password !== undefined) return { user, password };
  return undefined;
};

const siblingCreds = (sibling: AppFeatureServiceView): PmaCreds => {
  const creds = sibling.normalizedConfig.creds;
  const environment = sibling.normalizedConfig.environment ?? {};
  const pairs = [
    [creds?.user, creds?.password],
    [environment.MYSQL_USER, environment.MYSQL_PASSWORD],
    [environment.MARIADB_USER, environment.MARIADB_PASSWORD],
  ] as const;
  for (const [user, password] of pairs) {
    if (user !== undefined && password !== undefined) return { user, password };
  }
  return DEFAULT_CREDS;
};

const credsAgree = (left: PmaCreds, right: PmaCreds): boolean =>
  left.user === right.user && left.password === right.password;

export const credentialsFor = (siblings: ReadonlyArray<AppFeatureServiceView>): PmaCreds => {
  const first = siblings[0];
  if (first === undefined) return DEFAULT_CREDS;
  const agreed = siblingCreds(first);
  return siblings.every((sibling) => credsAgree(siblingCreds(sibling), agreed)) ? agreed : DEFAULT_CREDS;
};

const hostsCredsError = (feature: string): PhpMyAdminHostsCredsError =>
  new PhpMyAdminHostsCredsError({
    message: `App feature ${feature} could not resolve credentials for authored hosts`,
    feature,
    remediation: "Add creds: on the phpmyadmin service.",
  });

export type AuthoredHostsWire =
  | {
      readonly _tag: "ok";
      readonly hosts: ReadonlyArray<string>;
      readonly creds: PmaCreds;
      readonly matched: ReadonlyArray<AppFeatureServiceView>;
    }
  | { readonly _tag: "fail"; readonly error: PhpMyAdminHostsCredsError };

export const resolveAuthoredHosts = (input: {
  readonly hosts: ReadonlyArray<string>;
  readonly siblings: ReadonlyArray<AppFeatureServiceView>;
  readonly pmaCreds: PmaCreds | undefined;
  readonly feature: string;
}): AuthoredHostsWire => {
  const byName = new Map(input.siblings.map((sibling) => [sibling.serviceName, sibling] as const));
  const matched: AppFeatureServiceView[] = [];
  for (const host of input.hosts) {
    const sibling = byName.get(host);
    if (sibling !== undefined) matched.push(sibling);
  }
  if (input.pmaCreds !== undefined) {
    return { _tag: "ok", hosts: input.hosts, creds: input.pmaCreds, matched };
  }
  const first = matched[0];
  if (first === undefined || matched.length !== input.hosts.length) {
    return { _tag: "ok", hosts: input.hosts, creds: DEFAULT_CREDS, matched };
  }
  const agreed = siblingCreds(first);
  if (!matched.every((sibling) => credsAgree(siblingCreds(sibling), agreed))) {
    return { _tag: "fail", error: hostsCredsError(input.feature) };
  }
  return { _tag: "ok", hosts: input.hosts, creds: agreed, matched };
};
