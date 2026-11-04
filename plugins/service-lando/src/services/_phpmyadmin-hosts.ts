import { DATABASE_FAMILY_DEFAULT_PORTS } from "@lando/sdk/database-creds";
import { PhpMyAdminHostsCredsError } from "@lando/sdk/errors";
import type { EnvironmentValue, ServiceConfig } from "@lando/sdk/schema";
import type { AppFeatureServiceView } from "@lando/sdk/services";
import { credentialValuesAgree } from "./_creds-helpers.ts";

export type PmaCreds = {
  readonly user: string;
  readonly password: EnvironmentValue;
};

export const authoredPmaCreds = (config: ServiceConfig): PmaCreds | undefined => {
  const user = config.creds?.user;
  const password = config.creds?.password;
  if (user !== undefined && password !== undefined) return { user, password };
  return undefined;
};

const siblingCreds = (sibling: AppFeatureServiceView): PmaCreds | undefined => sibling.connection?.creds;

const credsAgree = (left: PmaCreds, right: PmaCreds): boolean =>
  left.user === right.user && credentialValuesAgree(left.password, right.password);

const hostsCredsError = (feature: string): PhpMyAdminHostsCredsError =>
  new PhpMyAdminHostsCredsError({
    message: `App feature ${feature} requires matching canonical credentials for all selected hosts`,
    feature,
    remediation:
      "Use matching database credentials, separate phpMyAdmin services, or explicit creds: for external hosts.",
  });

export type AuthoredHostsWire =
  | {
      readonly _tag: "ok";
      readonly hosts: ReadonlyArray<string>;
      readonly ports: readonly number[];
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
  const ports: number[] = [];
  for (const host of input.hosts) {
    const sibling = byName.get(host);
    if (sibling === undefined) {
      ports.push(DATABASE_FAMILY_DEFAULT_PORTS.mysql);
    } else {
      if (sibling.connection === undefined) return { _tag: "fail", error: hostsCredsError(input.feature) };
      matched.push(sibling);
      ports.push(sibling.connection.port);
    }
  }
  if (input.pmaCreds !== undefined) {
    return { _tag: "ok", hosts: input.hosts, ports, creds: input.pmaCreds, matched };
  }
  const first = matched[0];
  if (first === undefined || matched.length !== input.hosts.length) {
    return { _tag: "fail", error: hostsCredsError(input.feature) };
  }
  const agreed = siblingCreds(first);
  if (
    agreed === undefined ||
    !matched.every((sibling) => {
      const creds = siblingCreds(sibling);
      return creds !== undefined && credsAgree(creds, agreed);
    })
  ) {
    return { _tag: "fail", error: hostsCredsError(input.feature) };
  }
  return { _tag: "ok", hosts: input.hosts, ports, creds: agreed, matched };
};
