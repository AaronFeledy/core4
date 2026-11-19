#!/usr/bin/env bun
/**
 * Maintainer canary for stock service image tags.
 *
 * Reads every stock artifact tag from the service-lando artifact tables
 * (`plugins/service-lando/src/services/*.ts`) and looks up how recently each tag
 * was rebuilt. Tags older than 90 days, and tags whose rebuild time cannot be
 * resolved, are reported as warnings.
 *
 * This is a maintainer canary. It does not replace the stock PHP weekly refresh
 * (`ARTIFACT_REFRESH_EXTENSION`) or rebuild `refresh:true`.
 *
 * Warn, never fail, including on lookup failure or HTTP 429. A failed lookup is
 * never treated as fresh. Non-Hub Registry API v2 hosts have no `last_updated`
 * field; do not use the HTTP Date header for them.
 */
import { appendFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "@typescript/typescript6";

export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_RETRY_ATTEMPTS = 4;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ZERO_TIME_MS = Date.parse("0001-01-01T00:00:00Z");
const HUB_REGISTRIES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
const MANIFEST_ACCEPT =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

const STOCK_BINDING = /^(?:(?:DEFAULT_)?IMAGE|.+_IMAGE|.+_ARTIFACTS|ARTIFACTS|STATIC_SERVER_IMAGES)$/u;
const IMAGE_REF =
  /^(?:(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9._-]*(?:@sha256:[a-f0-9]{64})?$/u;

export type TagAgeVerdict = "fresh" | "stale" | "unknown";
export type RebuildSource = "hub-last-updated" | "registry-config-created" | "unknown";
export type CanaryFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CanarySleep = (ms: number) => Promise<void>;

export type ParsedStockImage = {
  readonly registry: string;
  readonly repository: string;
  readonly tag: string;
  readonly digest: string | undefined;
  readonly original: string;
};

export type TagLookup = {
  readonly tag: string;
  readonly rebuiltAt: string | undefined;
  readonly rebuiltAtMs: number | undefined;
  readonly verdict: TagAgeVerdict;
  readonly source: RebuildSource;
  readonly detail: string;
};

export type CanarySummary = {
  readonly lookups: readonly TagLookup[];
  readonly stale: readonly TagLookup[];
  readonly unknown: readonly TagLookup[];
  readonly fresh: readonly TagLookup[];
  readonly markdown: string;
};

type EvalValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "array"; readonly items: readonly EvalValue[] }
  | { readonly kind: "object"; readonly fields: ReadonlyMap<string, EvalValue> }
  | { readonly kind: "fn"; readonly fn: ts.FunctionLikeDeclarationBase }
  | { readonly kind: "unknown" };

type FileScope = {
  readonly fileName: string;
  readonly source: ts.SourceFile;
  readonly bindings: Map<string, ts.Expression>;
  readonly functions: Map<string, ts.FunctionLikeDeclarationBase>;
  readonly imports: ReadonlyMap<string, { readonly from: string; readonly name: string }>;
};

const unknownValue: EvalValue = { kind: "unknown" };
const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isStockImageRef = (value: string): boolean => IMAGE_REF.test(value);

export const parseStockImageRef = (value: string): ParsedStockImage | undefined => {
  if (!isStockImageRef(value)) return undefined;
  const digestIndex = value.lastIndexOf("@sha256:");
  const tagged = digestIndex === -1 ? value : value.slice(0, digestIndex);
  const digest = digestIndex === -1 ? undefined : value.slice(digestIndex + 1);
  const lastSlash = tagged.lastIndexOf("/");
  const tagSeparator = tagged.lastIndexOf(":");
  if (tagSeparator <= lastSlash) return undefined;
  const name = tagged.slice(0, tagSeparator);
  const tag = tagged.slice(tagSeparator + 1);
  const slash = name.indexOf("/");
  const first = slash < 0 ? name : name.slice(0, slash);
  const explicitRegistry = slash >= 0 && (/[.:]/u.test(first) || first === "localhost");
  const registry = explicitRegistry ? first : "docker.io";
  let repository = explicitRegistry ? name.slice(slash + 1) : name;
  if (HUB_REGISTRIES.has(registry) && !repository.includes("/")) repository = `library/${repository}`;
  return {
    registry: HUB_REGISTRIES.has(registry) ? "docker.io" : registry,
    repository,
    tag,
    digest,
    original: value,
  };
};

export const hubTagUrl = (image: ParsedStockImage): string | undefined => {
  if (!HUB_REGISTRIES.has(image.registry)) return undefined;
  const slash = image.repository.indexOf("/");
  if (slash <= 0) return undefined;
  const namespace = image.repository.slice(0, slash);
  const name = image.repository.slice(slash + 1);
  if (name.includes("/")) return undefined;
  return `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/tags/${encodeURIComponent(image.tag)}`;
};

export const registryManifestUrl = (image: ParsedStockImage): string =>
  `https://${image.registry}/v2/${image.repository}/manifests/${encodeURIComponent(image.tag)}`;

export const classifyTagAge = (
  rebuiltAtMs: number | undefined,
  nowMs: number,
  staleAfterMs = STALE_AFTER_MS,
): TagAgeVerdict => {
  if (rebuiltAtMs === undefined || !Number.isFinite(rebuiltAtMs)) return "unknown";
  return nowMs - rebuiltAtMs > staleAfterMs ? "stale" : "fresh";
};

export const parseRebuildTimestamp = (value: string | undefined): number | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= ZERO_TIME_MS) return undefined;
  return ms;
};

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const stringValue = (value: EvalValue): string | undefined =>
  value.kind === "string" ? value.value : value.kind === "number" ? String(value.value) : undefined;

const collectStockImageRefs = (value: EvalValue, into: Set<string>): void => {
  switch (value.kind) {
    case "string":
      if (isStockImageRef(value.value)) into.add(value.value.replace(/@sha256:[a-f0-9]{64}$/u, ""));
      return;
    case "array":
      for (const item of value.items) collectStockImageRefs(item, into);
      return;
    case "object":
      for (const field of value.fields.values()) collectStockImageRefs(field, into);
      return;
    default:
  }
};

const parseSource = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const importedName = (binding: ts.ImportSpecifier | ts.ImportClause): string => {
  if (ts.isImportSpecifier(binding)) return (binding.propertyName ?? binding.name).text;
  return "default";
};

const buildFileScope = (fileName: string, text: string): FileScope => {
  const source = parseSource(fileName, text);
  const bindings = new Map<string, ts.Expression>();
  const functions = new Map<string, ts.FunctionLikeDeclarationBase>();
  const imports = new Map<string, { from: string; name: string }>();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const from = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name !== undefined) imports.set(clause.name.text, { from, name: "default" });
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          imports.set(element.name.text, { from, name: importedName(element) });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        functions.set(declaration.name.text, initializer);
      } else {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return { fileName, source, bindings, functions, imports };
};

const resolveImported = (
  files: ReadonlyMap<string, FileScope>,
  fromFile: string,
  specifier: string,
): FileScope | undefined => {
  const resolved = specifier.endsWith(".ts")
    ? resolve(dirname(fromFile), specifier)
    : resolve(dirname(fromFile), `${specifier}.ts`);
  return files.get(resolved);
};

const evaluate = (
  expression: ts.Expression,
  scope: FileScope,
  files: ReadonlyMap<string, FileScope>,
  locals: ReadonlyMap<string, EvalValue> = new Map(),
): EvalValue => {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "string", value: node.text };
  }
  if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isIdentifier(node)) return lookup(node.text, scope, files, locals);
  if (ts.isArrayLiteralExpression(node)) {
    const items: EvalValue[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evaluate(element.expression, scope, files, locals);
        if (spread.kind === "array") items.push(...spread.items);
        else return unknownValue;
      } else {
        items.push(evaluate(element, scope, files, locals));
      }
    }
    return { kind: "array", items };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const fields = new Map<string, EvalValue>();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;
      if (key === undefined) continue;
      fields.set(key, evaluate(property.initializer, scope, files, locals));
    }
    return { kind: "object", fields };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = stringValue(evaluate(span.expression, scope, files, locals));
      if (part === undefined) return unknownValue;
      value += `${part}${span.literal.text}`;
    }
    return { kind: "string", value };
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const owner = evaluate(node.expression, scope, files, locals);
    if (owner.kind !== "object") return unknownValue;
    return owner.fields.get(node.name.text) ?? unknownValue;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    const owner = evaluate(node.expression, scope, files, locals);
    const key = evaluate(node.argumentExpression, scope, files, locals);
    if (owner.kind === "object") {
      const field = stringValue(key);
      return field === undefined ? unknownValue : (owner.fields.get(field) ?? unknownValue);
    }
    if (owner.kind === "array" && key.kind === "number") return owner.items[key.value] ?? unknownValue;
    return unknownValue;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, scope, files, locals);
    const right = evaluate(node.right, scope, files, locals);
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return { kind: "boolean", value: JSON.stringify(left) === JSON.stringify(right) };
    }
    if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return { kind: "boolean", value: JSON.stringify(left) !== JSON.stringify(right) };
    }
    return unknownValue;
  }
  if (ts.isConditionalExpression(node)) {
    const condition = evaluate(node.condition, scope, files, locals);
    if (condition.kind !== "boolean") return unknownValue;
    return evaluate(condition.value ? node.whenTrue : node.whenFalse, scope, files, locals);
  }
  if (ts.isCallExpression(node)) return evaluateCall(node, scope, files, locals);
  return unknownValue;
};

const lookup = (
  name: string,
  scope: FileScope,
  files: ReadonlyMap<string, FileScope>,
  locals: ReadonlyMap<string, EvalValue>,
): EvalValue => {
  const local = locals.get(name);
  if (local !== undefined) return local;
  const fn = scope.functions.get(name);
  if (fn !== undefined) return { kind: "fn", fn };
  const binding = scope.bindings.get(name);
  if (binding !== undefined) return evaluate(binding, scope, files, locals);
  const imported = scope.imports.get(name);
  if (imported === undefined) return unknownValue;
  const target = resolveImported(files, scope.fileName, imported.from);
  if (target === undefined) return unknownValue;
  return lookup(imported.name, target, files, new Map());
};

const evaluateFunction = (
  fn: ts.FunctionLikeDeclarationBase,
  args: readonly EvalValue[],
  owner: FileScope,
  files: ReadonlyMap<string, FileScope>,
  outer: ReadonlyMap<string, EvalValue>,
): EvalValue => {
  const locals = new Map(outer);
  let index = 0;
  for (const parameter of fn.parameters) {
    if (ts.isIdentifier(parameter.name)) locals.set(parameter.name.text, args[index] ?? unknownValue);
    index += 1;
  }
  if (fn.body === undefined) return unknownValue;
  if (!ts.isBlock(fn.body)) return evaluate(fn.body, owner, files, locals);
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
      return evaluate(statement.expression, owner, files, locals);
    }
  }
  return unknownValue;
};

const mapCallback = (
  callback: ts.Expression,
  items: readonly EvalValue[],
  scope: FileScope,
  files: ReadonlyMap<string, FileScope>,
  locals: ReadonlyMap<string, EvalValue>,
): EvalValue => {
  const fn = unwrap(callback);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return unknownValue;
  const mapped: EvalValue[] = [];
  for (const item of items) {
    mapped.push(evaluateFunction(fn, [item], scope, files, locals));
  }
  return { kind: "array", items: mapped };
};

const evaluateCall = (
  node: ts.CallExpression,
  scope: FileScope,
  files: ReadonlyMap<string, FileScope>,
  locals: ReadonlyMap<string, EvalValue>,
): EvalValue => {
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const owner = evaluate(callee.expression, scope, files, locals);
    const method = callee.name.text;
    if (
      method === "fromEntries" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object"
    ) {
      const entries =
        node.arguments[0] === undefined ? unknownValue : evaluate(node.arguments[0], scope, files, locals);
      if (entries.kind !== "array") return unknownValue;
      const fields = new Map<string, EvalValue>();
      for (const entry of entries.items) {
        if (entry.kind !== "array" || entry.items.length < 2) continue;
        const key = stringValue(entry.items[0] ?? unknownValue);
        const value = entry.items[1];
        if (key === undefined || value === undefined) continue;
        fields.set(key, value);
      }
      return { kind: "object", fields };
    }
    if (method === "map" && owner.kind === "array" && node.arguments[0] !== undefined) {
      return mapCallback(node.arguments[0], owner.items, scope, files, locals);
    }
  }
  if (ts.isIdentifier(callee) && callee.text === "String" && node.arguments[0] !== undefined) {
    const value = stringValue(evaluate(node.arguments[0], scope, files, locals));
    return value === undefined ? unknownValue : { kind: "string", value };
  }
  if (ts.isIdentifier(callee)) {
    const target = lookup(callee.text, scope, files, locals);
    if (target.kind !== "fn") return unknownValue;
    const args = node.arguments.map((argument) => evaluate(argument, scope, files, locals));
    const owner = scope.functions.has(callee.text)
      ? scope
      : (() => {
          const imported = scope.imports.get(callee.text);
          return imported === undefined
            ? scope
            : (resolveImported(files, scope.fileName, imported.from) ?? scope);
        })();
    return evaluateFunction(target.fn, args, owner, files, locals);
  }
  return unknownValue;
};

const isStockBindingName = (name: string): boolean => STOCK_BINDING.test(name);

export const extractStockArtifactTagsFromFiles = (files: ReadonlyMap<string, string>): readonly string[] => {
  const scopes = new Map<string, FileScope>();
  for (const [fileName, text] of files)
    scopes.set(resolve(fileName), buildFileScope(resolve(fileName), text));
  const tags = new Set<string>();
  for (const scope of scopes.values()) {
    for (const [name, initializer] of scope.bindings) {
      if (!isStockBindingName(name)) continue;
      collectStockImageRefs(evaluate(initializer, scope, scopes), tags);
    }
    for (const statement of scope.source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer === undefined) continue;
        collectInlineArtifactMaps(declaration.initializer, scope, scopes, tags);
      }
    }
  }
  return [...tags].sort();
};

const collectInlineArtifactMaps = (
  expression: ts.Expression,
  scope: FileScope,
  files: ReadonlyMap<string, FileScope>,
  tags: Set<string>,
): void => {
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "artifacts" &&
      ts.isObjectLiteralExpression(unwrap(node.initializer))
    ) {
      collectStockImageRefs(evaluate(node.initializer, scope, files), tags);
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
};

export const extractStockArtifactTagsFromDirectory = async (
  directory: string,
): Promise<readonly string[]> => {
  const root = resolve(directory);
  const files = new Map<string, string>();
  const pending: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    pending.push(join(root, entry.name));
  }
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || files.has(path)) continue;
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const text = await file.text();
    files.set(path, text);
    const source = parseSource(path, text);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      pending.push(
        specifier.endsWith(".ts")
          ? resolve(dirname(path), specifier)
          : resolve(dirname(path), `${specifier}.ts`),
      );
    }
  }
  return extractStockArtifactTagsFromFiles(files);
};

export const extractStockArtifactTags = (source: string, fileName = "fixture.ts"): readonly string[] =>
  extractStockArtifactTagsFromFiles(new Map([[fileName, source]]));

const retryAfterMs = (response: Response, attempt: number, baseDelayMs: number): number => {
  const header = response.headers.get("retry-after");
  if (header !== null && /^[0-9]+$/u.test(header)) {
    return Math.min(Number(header) * 1_000, 60_000);
  }
  return baseDelayMs * 2 ** attempt;
};

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

export const canaryFetch: CanaryFetch = (url, init) =>
  fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const requestWithRetry = async (
  url: string,
  init: RequestInit,
  fetchImpl: CanaryFetch,
  sleep: CanarySleep,
  attempts: number,
  baseDelayMs: number,
): Promise<Response | undefined> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (isRetryableStatus(response.status) && attempt < attempts - 1) {
        await sleep(retryAfterMs(response, attempt, baseDelayMs));
        continue;
      }
      return response;
    } catch {
      if (attempt < attempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
};

const parseWwwAuthenticate = (
  header: string | null,
): { readonly realm: string; readonly service?: string; readonly scope?: string } | undefined => {
  if (header === null || !header.startsWith("Bearer ")) return undefined;
  const fields = new Map<string, string>();
  for (const part of header.slice("Bearer ".length).split(",")) {
    const match = /^\s*([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]*))\s*$/u.exec(part);
    if (match?.[1] === undefined) continue;
    fields.set(match[1], match[2] ?? match[3] ?? "");
  }
  const realm = fields.get("realm");
  if (realm === undefined || !realm.startsWith("https://")) return undefined;
  const service = fields.get("service");
  const scope = fields.get("scope");
  return { realm, ...(service === undefined ? {} : { service }), ...(scope === undefined ? {} : { scope }) };
};

const bearerToken = async (
  authenticate: string | null,
  fetchImpl: CanaryFetch,
  sleep: CanarySleep,
  attempts: number,
  baseDelayMs: number,
): Promise<string | undefined> => {
  const challenge = parseWwwAuthenticate(authenticate);
  if (challenge === undefined) return undefined;
  const url = new URL(challenge.realm);
  if (challenge.service !== undefined) url.searchParams.set("service", challenge.service);
  if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope);
  const response = await requestWithRetry(url.href, {}, fetchImpl, sleep, attempts, baseDelayMs);
  if (response === undefined || !response.ok) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  if (!isJsonRecord(body) || typeof body.token !== "string" || body.token.length === 0) {
    return isJsonRecord(body) && typeof body.access_token === "string" ? body.access_token : undefined;
  }
  return body.token;
};

const pickManifestDigest = (body: unknown): string | undefined => {
  if (!isJsonRecord(body)) return undefined;
  if (isJsonRecord(body.config) && typeof body.config.digest === "string") return undefined;
  if (!Array.isArray(body.manifests)) return undefined;
  const manifests = body.manifests.filter(isJsonRecord);
  const linuxAmd64 = manifests.find((entry) => {
    const platform = entry.platform;
    return isJsonRecord(platform) && platform.os === "linux" && platform.architecture === "amd64";
  });
  const linux = manifests.find((entry) => isJsonRecord(entry.platform) && entry.platform.os === "linux");
  const chosen = linuxAmd64 ?? linux ?? manifests[0];
  return chosen !== undefined && typeof chosen.digest === "string" ? chosen.digest : undefined;
};

const configDigest = (body: unknown): string | undefined => {
  if (!isJsonRecord(body) || !isJsonRecord(body.config) || typeof body.config.digest !== "string") {
    return undefined;
  }
  return body.config.digest;
};

const configCreated = (body: unknown): string | undefined => {
  if (!isJsonRecord(body) || typeof body.created !== "string") return undefined;
  return body.created;
};

const registryGet = async (
  image: ParsedStockImage,
  path: string,
  fetchImpl: CanaryFetch,
  sleep: CanarySleep,
  attempts: number,
  baseDelayMs: number,
): Promise<unknown> => {
  const url = `https://${image.registry}/v2/${image.repository}/${path}`;
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  const first = await requestWithRetry(url, { headers }, fetchImpl, sleep, attempts, baseDelayMs);
  if (first === undefined) return undefined;
  let response = first;
  if (response.status === 401) {
    const token = await bearerToken(
      response.headers.get("www-authenticate"),
      fetchImpl,
      sleep,
      attempts,
      baseDelayMs,
    );
    if (token === undefined) return undefined;
    const authorized = await requestWithRetry(
      url,
      { headers: { ...headers, Authorization: `Bearer ${token}` } },
      fetchImpl,
      sleep,
      attempts,
      baseDelayMs,
    );
    if (authorized === undefined) return undefined;
    response = authorized;
  }
  if (!response.ok) return undefined;
  return response.json().catch(() => undefined);
};

export type LookupOptions = {
  readonly fetch?: CanaryFetch;
  readonly sleep?: CanarySleep;
  readonly nowMs?: number;
  readonly staleAfterMs?: number;
  readonly attempts?: number;
  readonly baseDelayMs?: number;
};

export const lookupTagRebuild = async (tag: string, options: LookupOptions = {}): Promise<TagLookup> => {
  const fetchImpl = options.fetch ?? canaryFetch;
  const sleep = options.sleep ?? Bun.sleep;
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const parsed = parseStockImageRef(tag);
  if (parsed === undefined) {
    return {
      tag,
      rebuiltAt: undefined,
      rebuiltAtMs: undefined,
      verdict: "unknown",
      source: "unknown",
      detail: "unparseable image reference",
    };
  }
  const hub = hubTagUrl(parsed);
  if (hub !== undefined) {
    const response = await requestWithRetry(hub, {}, fetchImpl, sleep, attempts, baseDelayMs);
    if (response === undefined) {
      return unknownLookup(tag, "hub lookup failed");
    }
    if (!response.ok) {
      return unknownLookup(tag, `hub HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const lastUpdated =
      isJsonRecord(body) && typeof body.last_updated === "string" ? body.last_updated : undefined;
    const rebuiltAtMs = parseRebuildTimestamp(lastUpdated);
    if (rebuiltAtMs === undefined) {
      return unknownLookup(tag, "hub last_updated missing");
    }
    return {
      tag,
      rebuiltAt: new Date(rebuiltAtMs).toISOString(),
      rebuiltAtMs,
      verdict: classifyTagAge(rebuiltAtMs, nowMs, staleAfterMs),
      source: "hub-last-updated",
      detail: "Docker Hub last_updated",
    };
  }
  const manifest = await registryGet(
    parsed,
    `manifests/${encodeURIComponent(parsed.tag)}`,
    fetchImpl,
    sleep,
    attempts,
    baseDelayMs,
  );
  const childDigest = pickManifestDigest(manifest);
  const manifestBody =
    childDigest === undefined
      ? manifest
      : await registryGet(parsed, `manifests/${childDigest}`, fetchImpl, sleep, attempts, baseDelayMs);
  const digest = configDigest(manifestBody);
  if (digest === undefined) {
    return unknownLookup(tag, "registry config digest missing");
  }
  const config = await registryGet(parsed, `blobs/${digest}`, fetchImpl, sleep, attempts, baseDelayMs);
  const created = configCreated(config);
  const rebuiltAtMs = parseRebuildTimestamp(created);
  if (rebuiltAtMs === undefined) {
    return unknownLookup(tag, "registry config created missing");
  }
  return {
    tag,
    rebuiltAt: new Date(rebuiltAtMs).toISOString(),
    rebuiltAtMs,
    verdict: classifyTagAge(rebuiltAtMs, nowMs, staleAfterMs),
    source: "registry-config-created",
    detail: "image config created",
  };
};

const unknownLookup = (tag: string, detail: string): TagLookup => ({
  tag,
  rebuiltAt: undefined,
  rebuiltAtMs: undefined,
  verdict: "unknown",
  source: "unknown",
  detail,
});

const daysAgo = (rebuiltAtMs: number, nowMs: number): string =>
  `${Math.floor((nowMs - rebuiltAtMs) / (24 * 60 * 60 * 1000))} days`;

export const formatCanarySummary = (lookups: readonly TagLookup[], nowMs: number): string => {
  const stale = lookups.filter((entry) => entry.verdict === "stale");
  const unknown = lookups.filter((entry) => entry.verdict === "unknown");
  const fresh = lookups.filter((entry) => entry.verdict === "fresh");
  const lines = [
    "# Stock artifact age canary",
    "",
    "Maintainer canary for stock service image tags. Warns when a tag is older than 90 days or cannot be dated.",
    "Does not replace stock PHP weekly refresh (`ARTIFACT_REFRESH_EXTENSION`) or rebuild `refresh:true`.",
    "",
    `Checked ${lookups.length} tags: ${stale.length} stale, ${unknown.length} unknown, ${fresh.length} fresh.`,
    "",
    "## Stale",
    "",
  ];
  if (stale.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| Tag | Last rebuilt | Age |", "| --- | --- | --- |");
    for (const entry of stale) {
      lines.push(
        `| \`${entry.tag}\` | ${entry.rebuiltAt ?? "unknown"} | ${entry.rebuiltAtMs === undefined ? "unknown" : daysAgo(entry.rebuiltAtMs, nowMs)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Unknown", "");
  if (unknown.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| Tag | Reason |", "| --- | --- |");
    for (const entry of unknown) {
      lines.push(`| \`${entry.tag}\` | ${entry.detail} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
};

export const buildCanarySummary = (lookups: readonly TagLookup[], nowMs: number): CanarySummary => {
  const sorted = [...lookups].sort((left, right) => left.tag.localeCompare(right.tag));
  return {
    lookups: sorted,
    stale: sorted.filter((entry) => entry.verdict === "stale"),
    unknown: sorted.filter((entry) => entry.verdict === "unknown"),
    fresh: sorted.filter((entry) => entry.verdict === "fresh"),
    markdown: formatCanarySummary(sorted, nowMs),
  };
};

export type RunCanaryOptions = LookupOptions & {
  readonly directory?: string;
};

export const runStockArtifactAgeCanary = async (options: RunCanaryOptions = {}): Promise<CanarySummary> => {
  const directory =
    options.directory ?? resolve(import.meta.dirname, "../plugins/service-lando/src/services");
  const tags = await extractStockArtifactTagsFromDirectory(directory);
  const nowMs = options.nowMs ?? Date.now();
  const lookups: TagLookup[] = [];
  for (const tag of tags) {
    lookups.push(await lookupTagRebuild(tag, { ...options, nowMs }));
  }
  const summary = buildCanarySummary(lookups, nowMs);
  return summary;
};

const writeGithubOutput = async (summary: CanarySummary): Promise<void> => {
  process.stdout.write(summary.markdown);
  for (const entry of summary.stale) {
    process.stdout.write(
      `::warning title=Stale stock image::${entry.tag} last rebuilt ${entry.rebuiltAt ?? "unknown"}\n`,
    );
  }
  for (const entry of summary.unknown) {
    process.stdout.write(`::warning title=Unknown stock image age::${entry.tag} (${entry.detail})\n`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && summaryPath.length > 0) {
    await appendFile(summaryPath, summary.markdown);
  }
};

if (import.meta.main) {
  const summary = await runStockArtifactAgeCanary();
  await writeGithubOutput(summary);
  process.exitCode = 0;
}
