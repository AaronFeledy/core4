import { DATABASE_FAMILY_DEFAULT_PORTS } from "@lando/sdk/database-creds";
import { PhpMyAdminHostsCredsError } from "@lando/sdk/errors";
import type { EnvironmentValue, ServiceConfig } from "@lando/sdk/schema";
import type { AppFeatureServiceView } from "@lando/sdk/services";
import { credentialValuesAgree } from "./_creds-helpers.ts";

export type PmaCreds = {
  readonly user: string;
  readonly password: EnvironmentValue;
};

export type AuthoredPmaCreds = Partial<PmaCreds>;

export const authoredPmaCreds = (config: ServiceConfig): AuthoredPmaCreds | undefined => {
  const user = config.creds?.user;
  const password = config.creds?.password;
  if (user === undefined && password === undefined) return undefined;
  return {
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
  };
};

const siblingCreds = (sibling: AppFeatureServiceView): PmaCreds | undefined => sibling.connection?.creds;

const hostsCredsError = (feature: string): PhpMyAdminHostsCredsError =>
  new PhpMyAdminHostsCredsError({
    message: `App feature ${feature} requires matching canonical credentials for all selected hosts`,
    feature,
    remediation:
      "Use matching database credentials, separate phpMyAdmin services, or explicit creds: for external hosts.",
  });

const missingMemberError = (feature: string, member: "user" | "password"): PhpMyAdminHostsCredsError =>
  new PhpMyAdminHostsCredsError({
    message: `App feature ${feature} cannot determine the phpMyAdmin ${member} for every selected host`,
    feature,
    remediation: `Set creds.${member} on the phpmyadmin service, or select hosts whose ${member} agrees.`,
  });

const agreedMembers = (siblings: ReadonlyArray<AppFeatureServiceView>): AuthoredPmaCreds => {
  const first = siblings[0] === undefined ? undefined : siblingCreds(siblings[0]);
  if (first === undefined) return {};
  const userAgrees = siblings.every((sibling) => siblingCreds(sibling)?.user === first.user);
  const passwordAgrees = siblings.every((sibling) => {
    const password = siblingCreds(sibling)?.password;
    return password !== undefined && credentialValuesAgree(password, first.password);
  });
  return {
    ...(userAgrees ? { user: first.user } : {}),
    ...(passwordAgrees ? { password: first.password } : {}),
  };
};

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
  readonly pmaCreds: AuthoredPmaCreds | undefined;
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
  // A sibling member can only be used when every authored host is a sibling and they all agree;
  // an external host or a disagreement leaves that member for the phpmyadmin service to author.
  const agreed = matched.length === input.hosts.length ? agreedMembers(matched) : {};
  const user = input.pmaCreds?.user ?? agreed.user;
  const password = input.pmaCreds?.password ?? agreed.password;
  if (user === undefined) return { _tag: "fail", error: missingMemberError(input.feature, "user") };
  if (password === undefined) return { _tag: "fail", error: missingMemberError(input.feature, "password") };
  return { _tag: "ok", hosts: input.hosts, ports, creds: { user, password }, matched };
};
