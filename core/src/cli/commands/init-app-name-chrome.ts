import { DEFAULT_PROXY_DOMAIN, normalizeAppSlug } from "@lando/engine/planner/naming";

import type { PromptChrome } from "../../recipes/prompts/driver";

const APP_NAME_PROMPT = "name";

const NON_PROXY_SERVICE =
  /^(database|db|cache|redis|memcached|mail|mailhog|solr|elasticsearch|index|mongo|mysql|mariadb|postgres|postgresql)$/;

export const APP_NAME_HELP = "Used as the Landofile name and the app id.";

export const inferDefaultProxyService = (landofileYaml: string): string | undefined => {
  if (!/^services:/m.test(landofileYaml)) return undefined;
  const names = [...landofileYaml.matchAll(/^ {2}([a-z][a-z0-9-]*):/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return names.find((name) => !NON_PROXY_SERVICE.test(name));
};

export const previewAppSlug = (raw: string, appRoot: string): string | undefined => {
  if (raw.trim() === "") return undefined;
  return normalizeAppSlug(raw, appRoot);
};

export const renderMachineNameFooter = (raw: string, appRoot: string): string => {
  const slug = previewAppSlug(raw, appRoot);
  return slug === undefined ? "Machine name: —" : `Machine name: ${slug}`;
};

export const renderProxyUrlFooter = (
  raw: string,
  appRoot: string,
  service: string,
  domain = DEFAULT_PROXY_DOMAIN,
): string => {
  const slug = previewAppSlug(raw, appRoot);
  return slug === undefined ? "URL: —" : `URL: https://${service}.${slug}.${domain}`;
};

export const appNamePromptChrome = (input: {
  readonly appRoot: string;
  readonly proxyService?: string;
  readonly proxyDomain?: string;
}): PromptChrome => {
  const domain = input.proxyDomain ?? DEFAULT_PROXY_DOMAIN;
  const proxyService = input.proxyService;
  const footer = [
    {
      id: "machine-name",
      render: (raw: string) => renderMachineNameFooter(raw, input.appRoot),
    },
    ...(proxyService === undefined
      ? []
      : [
          {
            id: "url",
            render: (raw: string) => renderProxyUrlFooter(raw, input.appRoot, proxyService, domain),
          },
        ]),
  ];
  return { help: APP_NAME_HELP, footer };
};

export const appNameChromeByPrompt = (input: {
  readonly appRoot: string;
  readonly proxyService?: string;
  readonly proxyDomain?: string;
}): Readonly<Record<string, PromptChrome>> => ({
  [APP_NAME_PROMPT]: appNamePromptChrome(input),
});

export const chromeForInitNamePrompt = (input: {
  readonly appRoot: string;
  readonly landofileYaml: string;
}): Readonly<Record<string, PromptChrome>> => {
  const proxyService = inferDefaultProxyService(input.landofileYaml);
  return appNameChromeByPrompt({
    appRoot: input.appRoot,
    ...(proxyService === undefined ? {} : { proxyService }),
  });
};
