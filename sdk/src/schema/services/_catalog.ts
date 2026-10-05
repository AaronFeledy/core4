import { Schema, Struct } from "effect";
import { ServiceConfig } from "../landofile.ts";

// ==== Catalog service field selection and metadata
export const CATALOG_SERVICE_HEAD_KEYS = ["image", "port", "user"] as const;
export const CATALOG_SERVICE_TAIL_KEYS = [
  "environment",
  "routes",
  "ports",
  "command",
  "entrypoint",
  "workingDirectory",
  "appMount",
  "mounts",
  "storage",
  "endpoints",
  "healthcheck",
  "dependsOn",
  "labels",
  "envFile",
  "networks",
  "security",
  "providers",
] as const;

type ServiceFields = typeof ServiceConfig.fields;
type ServiceKey = keyof ServiceFields;
type CommonKey = (typeof CATALOG_SERVICE_HEAD_KEYS)[number] | (typeof CATALOG_SERVICE_TAIL_KEYS)[number];
type CatalogMetadata<T extends Schema.Top, F extends Schema.Struct.Fields> = {
  readonly type: T;
  readonly fields?: F;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
};
type CatalogSchema<
  K extends ServiceKey,
  T extends Schema.Top,
  F extends Schema.Struct.Fields,
> = Schema.Struct<Omit<Pick<ServiceFields, K>, "type" | keyof F> & { readonly type: T } & F>;

export const catalogServiceType = <S extends Schema.Top>(literalSchema: S, description: string) =>
  Schema.optionalKey(literalSchema).annotate({ description });

export function catalogServiceConfig<
  K extends ServiceKey,
  T extends Schema.Top,
  F extends Schema.Struct.Fields = Record<never, never>,
>(
  options: CatalogMetadata<T, F> & { readonly keys: readonly K[]; readonly extraKeys?: never },
): CatalogSchema<K, T, F>;
export function catalogServiceConfig<
  K extends ServiceKey = never,
  T extends Schema.Top = Schema.Top,
  F extends Schema.Struct.Fields = Record<never, never>,
>(
  options: CatalogMetadata<T, F> & { readonly extraKeys?: readonly K[]; readonly keys?: never },
): CatalogSchema<CommonKey | K, T, F>;
export function catalogServiceConfig(
  options: CatalogMetadata<Schema.Top, Schema.Struct.Fields> & {
    readonly keys?: readonly ServiceKey[];
    readonly extraKeys?: readonly ServiceKey[];
  },
) {
  const keys = options.keys ?? [
    ...CATALOG_SERVICE_HEAD_KEYS,
    ...(options.extraKeys ?? []),
    ...CATALOG_SERVICE_TAIL_KEYS,
  ];
  return Schema.Struct(Struct.pick(ServiceConfig.fields, keys))
    .pipe(Schema.fieldsAssign({ type: options.type, ...options.fields }))
    .annotate({ identifier: options.identifier, title: options.title, description: options.description });
}
