import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError, ServiceFeatureError } from "@lando/sdk/errors";
import { isPlainRecord } from "@lando/sdk/landofile";
import {
  EndpointDeclaration,
  formatValidationIssuePath,
  validationIssue,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { Schema } from "effect";

const declarations = Schema.Array(EndpointDeclaration);
const decodeList = Schema.decodeUnknownEffect(declarations);
const decodeMap = Schema.decodeUnknownEffect(
  Schema.Unknown.check(Schema.makeFilter(isPlainRecord)).pipe(
    Schema.decodeTo(Schema.Record(Schema.String, declarations)),
  ),
);
const strict = { onExcessProperty: "error" } as const;
const fields = new Set([
  "kind",
  "protocol",
  "port",
  "name",
  "primary",
  "appProtocol",
  "socketPath",
  "publication",
  "scan",
  "path",
  "okCodes",
  "hostPort",
  "bindAddress",
  "_tag",
]);

const declarationError = (
  error: Schema.SchemaError,
  context: {
    readonly feature: string;
    readonly pluginId: string;
    readonly service?: string;
    readonly selected?: readonly string[];
  },
) => {
  const paths = validationIssuesFromSchemaIssue(error.issue).map(({ path }) => path);
  const path =
    paths.find((candidate) => candidate.some((part) => typeof part === "number")) ?? paths[0] ?? [];
  const [entry] = path;
  const service =
    context.service ?? (typeof entry === "string" && context.selected?.includes(entry) ? entry : undefined);
  const [index, ...tail] = context.selected === undefined ? path : path.slice(1);
  const fieldPath = tail.map((part) =>
    typeof part === "number" || fields.has(part) ? part : "<unknown field>",
  );
  const at = [
    "pluginEndpoints",
    ...(service === undefined ? [] : [service]),
    ...(typeof index === "number" ? [index] : []),
    ...fieldPath,
  ];
  const message = `Plugin ${context.pluginId} feature ${context.feature} returned an invalid endpoint declaration at ${formatValidationIssuePath(at)}.`;
  return new ServiceFeatureError({
    feature: context.feature,
    endpointDeclaration: {
      pluginId: context.pluginId,
      ...(service === undefined ? {} : { service }),
      ...(typeof index === "number" ? { index } : {}),
    },
    message,
    issues: [validationIssue(at, message)],
    remediation: "Update the plugin or report the invalid endpoint declaration to its maintainer.",
  });
};

export const decodeServiceEndpointDeclarations = (
  raw: unknown,
  context: { readonly feature: string; readonly pluginId: string; readonly service: string },
) => decodeList(raw, strict).pipe(mapFailures((error) => declarationError(error, context)));

export const decodeAppEndpointDeclarations = (
  raw: unknown,
  context: { readonly feature: string; readonly pluginId: string; readonly selected: readonly string[] },
) => decodeMap(raw, strict).pipe(mapFailures((error) => declarationError(error, context)));

/** Invalid plugin output is a plugin finding, not an authored service or app-feature field. */
export const endpointDeclarationValidationError = (appRoot: string, cause: unknown) =>
  cause instanceof ServiceFeatureError && cause.endpointDeclaration !== undefined
    ? new LandofileValidationError({
        message: cause.message,
        remediation: cause.remediation,
        file: appRoot,
        cause,
        issues: cause.issues ?? [],
      })
    : undefined;
