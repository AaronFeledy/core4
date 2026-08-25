export type HelpAliasPolicy = {
  readonly enabled?: boolean;
  readonly disabled?: ReadonlyArray<string>;
  readonly custom?: Readonly<Record<string, string>>;
};

export type TypeableNameInput = {
  readonly canonicalId: string;
  readonly builtInAliases: ReadonlyArray<string>;
  readonly aliasPolicy?: HelpAliasPolicy;
};

export type TypeableName = {
  readonly primary: string;
  readonly extras: ReadonlyArray<string>;
};

const isNameToken = (token: string): boolean => !token.startsWith("-");

const stripNamespacePrefix = (canonicalId: string): string | undefined => {
  const separator = canonicalId.indexOf(":");
  if (separator === -1) return undefined;
  const stripped = canonicalId.slice(separator + 1);
  return stripped.length === 0 ? undefined : stripped;
};

const implicitName = (canonicalId: string, builtInAliases: ReadonlyArray<string>): string | undefined =>
  builtInAliases.find(isNameToken) ?? stripNamespacePrefix(canonicalId);

export const typeableName = (input: TypeableNameInput): TypeableName => {
  const { canonicalId, builtInAliases, aliasPolicy } = input;
  const aliasesEnabled = aliasPolicy?.enabled !== false;
  const disabled = new Set(aliasPolicy?.disabled ?? []);
  const custom = aliasPolicy?.custom ?? {};

  const customTarget = (token: string): string | undefined =>
    Object.hasOwn(custom, token) ? custom[token] : undefined;

  const claimedByOther = (token: string): boolean => {
    const target = customTarget(token);
    return target !== undefined && target !== canonicalId;
  };

  const typeable = (token: string): boolean =>
    isNameToken(token) && !disabled.has(token) && !claimedByOther(token);

  const customs = aliasesEnabled
    ? Object.entries(custom)
        .filter(([alias, target]) => target === canonicalId && typeable(alias))
        .map(([alias]) => alias)
        .sort((left, right) => left.localeCompare(right))
    : [];

  const implicit = implicitName(canonicalId, builtInAliases);
  const implicitAvailable = aliasesEnabled && implicit !== undefined && typeable(implicit);

  const primary = customs[0] ?? (implicitAvailable && implicit !== undefined ? implicit : canonicalId);

  const extras: string[] = [];
  const seen = new Set<string>([primary]);
  const pushUnique = (token: string): void => {
    if (seen.has(token)) return;
    seen.add(token);
    extras.push(token);
  };

  for (const alias of customs) pushUnique(alias);
  if (implicitAvailable && implicit !== undefined) pushUnique(implicit);
  if (aliasesEnabled) {
    for (const alias of builtInAliases) {
      if (typeable(alias)) pushUnique(alias);
    }
  }
  pushUnique(canonicalId);

  return { primary, extras };
};
