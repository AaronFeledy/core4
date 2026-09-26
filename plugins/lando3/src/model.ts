/** Source-preserving shapes, not a validator for plugin-specific Lando 3 intent. */
import { type LegacyTagged, isLegacyTagged } from "@lando/sdk/landofile";
import { Schema, type SchemaAST } from "effect";
import type { Lando3Path } from "./contract.ts";

const Bag = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const Tagged = Schema.declare<LegacyTagged>(isLegacyTagged);
const Text = Schema.Union(Schema.String, Tagged);
const Strings = Schema.Array(Text);
const TextOrList = Schema.Union(Text, Strings);
const Toggle = Schema.Union(Schema.Boolean, Schema.String);
const Port = Schema.Union(Schema.Number, Schema.String);
const Environment = Schema.Union(Bag, Strings);
const open = <F extends Schema.Struct.Fields>(fields: F) => Schema.Struct(fields).pipe(Schema.extend(Bag));
const optional = Schema.optional;
const record = <A, I>(value: Schema.Schema<A, I>) => Schema.Record({ key: Schema.String, value });
const CommandMap = record(TextOrList);
const Command = Schema.Union(Text, Schema.Array(Schema.Union(Text, CommandMap)));

export const Lando3Scanner = open({
  okCodes: optional(Schema.Array(Schema.Number)),
  timeout: optional(Schema.Number),
  retry: optional(Schema.Number),
  path: optional(Text),
  maxRedirects: optional(Schema.Number),
});
export const Lando3Healthcheck = open({
  command: optional(TextOrList),
  user: optional(Text),
  retry: optional(Schema.Number),
  delay: optional(Schema.Number),
});
const healthcheck = optional(Schema.Union(Toggle, Tagged, Lando3Healthcheck));
const scanner = optional(Schema.Union(Schema.Boolean, Lando3Scanner));
const hooks = {
  build: optional(Command),
  build_as_root: optional(Command),
  build_internal: optional(Command),
  build_as_root_internal: optional(Command),
  run: optional(Command),
  run_as_root: optional(Command),
  run_internal: optional(Command),
  run_as_root_internal: optional(Command),
};
const api3 = {
  api: optional(Schema.Literal(3)),
  ...hooks,
  config: optional(Bag),
  overrides: optional(Bag),
  scanner,
  ssl: optional(Schema.Union(Schema.Boolean, Port)),
  sslExpose: optional(Schema.Boolean),
  app_mount: optional(Toggle),
  moreHttpPorts: optional(Schema.Array(Port)),
  meUser: optional(Text),
  home: optional(Schema.Unknown),
};

export const Lando3Api3CatalogService = open({
  ...api3,
  type: optional(Schema.String.pipe(Schema.filter((type) => type !== "lando" && type !== "compose"))),
  via: optional(Text),
  webroot: optional(Text),
  composer_version: optional(Toggle),
  composer: optional(Bag),
  xdebug: optional(
    Schema.Union(
      Toggle,
      open({
        mode: optional(Text),
        start_with_request: optional(Toggle),
        client_port: optional(Port),
        config: optional(Bag),
      }),
    ),
  ),
  db_client: optional(Text),
  path: optional(Strings),
  environment: optional(Environment),
  portforward: optional(Schema.Union(Schema.Boolean, Port)),
  creds: optional(open({ user: optional(Text), password: optional(Text), database: optional(Text) })),
  authentication: optional(Text),
  port: optional(Port),
  command: optional(TextOrList),
  globals: optional(Bag),
  password: optional(Text),
  persist: optional(Schema.Boolean),
  mem: optional(Port),
  plugins: optional(Strings),
  core: optional(Text),
  mailFrom: optional(Strings),
  maxMessages: optional(Schema.Number),
  hogfrom: optional(Strings),
  hosts: optional(Strings),
  backends: optional(Strings),
  backend: optional(Text),
  backend_port: optional(Port),
});
export type Lando3Api3CatalogService = typeof Lando3Api3CatalogService.Type;

export const Lando3Api3RawService = open({
  ...api3,
  type: Schema.Literal("lando", "compose"),
  services: optional(Bag),
  user: optional(Text),
  scriptsDir: optional(Text),
  sport: optional(Port),
  healthcheck,
  volumes: optional(Bag),
  networks: optional(Bag),
});
export type Lando3Api3RawService = typeof Lando3Api3RawService.Type;

const Mount = open({
  source: optional(Text),
  src: optional(Text),
  target: optional(Text),
  destination: optional(Text),
  dest: optional(Text),
  type: optional(Text),
  owner: optional(Text),
  permissions: optional(Port),
  user: optional(Text),
  group: optional(Text),
  content: optional(Text),
  contents: optional(Text),
  includes: optional(Strings),
  excludes: optional(Strings),
  scope: optional(Text),
  instructions: optional(Schema.Union(TextOrList, Schema.Array(Bag))),
});
const Mounts = Schema.Array(Schema.Union(Text, Mount));
export const Lando3Image = open({
  imagefile: optional(Text),
  dockerfile: optional(Text),
  tag: optional(Text),
  buildx: optional(Schema.Boolean),
  buildkit: optional(Schema.Boolean),
  ssh: optional(Schema.Union(Toggle, Strings)),
  args: optional(Environment),
  context: optional(Mounts),
  groups: optional(Schema.Array(Bag)),
  steps: optional(
    Schema.Array(
      open({
        instructions: optional(Schema.Union(TextOrList, Schema.Array(Bag))),
        group: optional(Text),
        weight: optional(Schema.Number),
        user: optional(Text),
      }),
    ),
  ),
});
export const Lando3Api4Service = open({
  api: Schema.Literal(4),
  type: optional(Schema.Literal("lando", "l337")),
  primary: optional(Schema.Boolean),
  image: optional(Schema.Union(Text, Lando3Image)),
  mounts: optional(Mounts),
  storage: optional(Mounts),
  "persistent-storage": optional(Mounts),
  appMount: optional(Schema.Union(Toggle, Mount)),
  "app-mount": optional(Schema.Union(Toggle, Mount)),
  certs: optional(Schema.Union(Toggle, open({ cert: optional(Text), key: optional(Text) }))),
  security: optional(
    open({
      ca: optional(TextOrList),
      cas: optional(TextOrList),
      "certificate-authority": optional(TextOrList),
      "certificate-authorities": optional(TextOrList),
    }),
  ),
  endpoints: optional(Schema.Union(Bag, Schema.Array(Schema.Union(Text, Bag)))),
  healthcheck,
  hostnames: optional(Strings),
  packages: optional(record(Schema.Boolean)),
  build: optional(open({ image: optional(Command), app: optional(Command), dockerfile: optional(Text) })),
  user: optional(Text),
  command: optional(TextOrList),
  entrypoint: optional(TextOrList),
  working_dir: optional(Text),
  tty: optional(Schema.Boolean),
  stdin_open: optional(Schema.Boolean),
  environment: optional(Environment),
  ports: optional(Schema.Array(Schema.Union(Port, Bag))),
  volumes: optional(Schema.Union(Strings, Bag)),
  networks: optional(Schema.Union(Strings, Bag)),
  labels: optional(Environment),
  overrides: optional(Bag),
  scanner,
  home: optional(Schema.Unknown),
});
export type Lando3Api4Service = typeof Lando3Api4Service.Type;

/** The record branch retains future APIs and malformed fields without claiming a typed family. */
export const Lando3Service = Schema.Union(
  Lando3Api3CatalogService,
  Lando3Api3RawService,
  Lando3Api4Service,
  Bag,
  Tagged,
  Schema.Boolean,
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Array(Schema.Unknown),
);
export type Lando3Service = typeof Lando3Service.Type;

export const Lando3ToolingEntry = open({
  service: optional(TextOrList),
  cmd: optional(Command),
  description: optional(Text),
  dir: optional(Text),
  env: optional(Environment),
  user: optional(Text),
  level: optional(Text),
  options: optional(record(Bag)),
  usage: optional(Text),
  examples: optional(Strings),
  interactive: optional(Schema.Union(Schema.Boolean, Bag)),
  disabled: optional(Schema.Boolean),
  positionals: optional(record(Bag)),
});
export type Lando3ToolingEntry = typeof Lando3ToolingEntry.Type;
export const Lando3Tooling = record(Schema.Union(Lando3ToolingEntry, Text, Schema.Boolean, Schema.Null, Bag));
export const Lando3Events = record(Schema.Array(Schema.Union(Text, CommandMap)));
export const Lando3ProxyRoute = open({
  hostname: optional(Text),
  port: optional(Port),
  pathname: optional(Text),
  middlewares: optional(
    Schema.Array(open({ name: optional(Text), key: optional(Text), value: optional(Schema.Unknown) })),
  ),
});
export const Lando3Proxy = record(Schema.Array(Schema.Union(Text, Lando3ProxyRoute)));

export const Lando3LandofileShape = open({
  name: optional(Text),
  recipe: optional(Text),
  config: optional(Bag),
  services: optional(record(Lando3Service)),
  tooling: optional(Lando3Tooling),
  events: optional(Lando3Events),
  proxy: optional(Lando3Proxy),
  compose: optional(TextOrList),
  excludes: optional(Strings),
  env_file: optional(TextOrList),
  keys: optional(Schema.Union(Schema.Boolean, Strings)),
  plugins: optional(record(Text)),
  pluginDirs: optional(Strings),
  volumes: optional(Bag),
  networks: optional(Bag),
  landoFile: optional(Text),
  preLandoFiles: optional(Strings),
  postLandoFiles: optional(Strings),
});
export type Lando3LandofileShape = typeof Lando3LandofileShape.Type;
/** Narrow with Lando3LandofileShape for typed fields; malformed documents remain intact records. */
export const Lando3Landofile = Schema.Union(Lando3LandofileShape, Bag);
export type Lando3Landofile = typeof Lando3Landofile.Type;
export interface Lando3DecodeResult {
  readonly landofile: Lando3Landofile;
  readonly unknownKeys: ReadonlyArray<Lando3Path>;
  readonly tags: ReadonlyArray<{ readonly path: Lando3Path; readonly tag: string }>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !isLegacyTagged(value);
const UnknownService = Schema.Struct({ api: optional(Schema.Unknown), type: optional(Schema.Unknown) });
const serviceAst = (value: Readonly<Record<string, unknown>>): SchemaAST.AST => {
  switch (value.api ?? 3) {
    case 3:
      return value.type === "lando" || value.type === "compose"
        ? Lando3Api3RawService.ast
        : Lando3Api3CatalogService.ast;
    case 4:
      return value.type === undefined || value.type === "lando" || value.type === "l337"
        ? Lando3Api4Service.ast
        : UnknownService.ast;
    default:
      return UnknownService.ast;
  }
};

/** Choose a structural branch even when a modeled field has an unexpected value. */
const structuralAst = (ast: SchemaAST.AST | undefined, value: unknown): SchemaAST.AST | undefined => {
  if (ast === undefined) return undefined;
  switch (ast._tag) {
    case "Refinement":
      return structuralAst(ast.from, value);
    case "Union":
      return ast.types
        .map((member) => structuralAst(member, value))
        .find(
          (member) =>
            (isRecord(value) && member?._tag === "TypeLiteral") ||
            (Array.isArray(value) && member?._tag === "TupleType"),
        );
    default:
      return ast;
  }
};

/**
 * Object.entries preserves parser insertion order except integer-like keys, whose
 * ECMAScript numeric order is stable. Unknown subtrees contribute only their root
 * path, but are still walked for tags. Markers themselves are always opaque.
 */
export const decodeLando3Landofile = (value: unknown): Lando3DecodeResult => {
  const unknownKeys: Lando3Path[] = [];
  const tags: Array<{ readonly path: Lando3Path; readonly tag: string }> = [];
  const ancestors = new Set<object>();
  const visit = (node: unknown, path: Lando3Path, shape: SchemaAST.AST | undefined): void => {
    if (isLegacyTagged(node)) {
      tags.push({ path, tag: node.tag });
      return;
    }
    if (typeof node !== "object" || node === null || ancestors.has(node)) return;
    ancestors.add(node);
    const ast = structuralAst(shape, node);
    if (Array.isArray(node)) {
      node.forEach((item: unknown, index) =>
        visit(
          item,
          [...path, index],
          ast?._tag === "TupleType" ? (ast.elements[index]?.type ?? ast.rest[0]?.type) : undefined,
        ),
      );
    } else if (isRecord(node)) {
      const selected =
        path.length === 2 && path[0] === "services" && shape !== undefined ? serviceAst(node) : ast;
      for (const [key, child] of Object.entries(node)) {
        const childPath = [...path, key];
        const fields = selected?._tag === "TypeLiteral" ? selected : undefined;
        const field = fields?.propertySignatures.find((property) => property.name === key);
        const bag = fields?.propertySignatures.length === 0 ? fields.indexSignatures[0]?.type : undefined;
        const ignored = path.length === 0 && key.startsWith("x-");
        if (fields !== undefined && field === undefined && bag === undefined && !ignored)
          unknownKeys.push(childPath);
        visit(child, childPath, ignored ? undefined : (field?.type ?? bag));
      }
    }
    ancestors.delete(node);
  };
  visit(value, [], Lando3LandofileShape.ast);
  // Checking the schema without projecting a new object retains marker and alias identity.
  const landofile = Schema.is(Lando3Landofile)(value) ? value : {};
  return { landofile, unknownKeys, tags };
};
