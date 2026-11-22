/** Deterministic Landofile structural mutations for differential publication parity. */

const service = (fields: object) => ({ name: "demo", services: { web: { type: "node:22", ...fields } } });
const environment = (value: unknown) => service({ environment: value });
const build = (value: unknown) => service({ build: value });

export type MutationKind =
  | "env-drop-equals"
  | "env-null-value"
  | "env-empty-name"
  | "env-reserved-name"
  | "env-list-map-swap"
  | "env-wrong-type"
  | "env-valid"
  | "build-unknown-key"
  | "build-wrong-type"
  | "build-list-map-swap"
  | "build-mixed-families"
  | "build-renamed-key"
  | "build-valid"
  | "build-expression"
  | "typed-expression"
  | "renamed-key"
  | "unknown-key"
  | "wrong-literal-type"
  | "ports";

export type PublicationCase = {
  readonly id: string;
  readonly kind: MutationKind;
  readonly input: unknown;
  /** Authoring decoder and Standard Schema accept. */
  readonly authoring: boolean;
  /** Runtime LandofileShape accept. */
  readonly runtime: boolean;
};

export const publicationCases: readonly PublicationCase[] = [
  // env
  {
    id: "env-list",
    kind: "env-valid",
    input: environment(["FOO=", "BAR=x=y"]),
    authoring: true,
    runtime: true,
  },
  {
    id: "env-map",
    kind: "env-valid",
    input: environment({ FOO: "", BAR: "x=y" }),
    authoring: true,
    runtime: true,
  },
  {
    id: "env-bare",
    kind: "env-drop-equals",
    input: environment(["FOO", "BAR=x=y"]),
    authoring: false,
    runtime: false,
  },
  {
    id: "env-reserved",
    kind: "env-reserved-name",
    input: environment(["__proto__=", "BAR=x=y"]),
    authoring: false,
    runtime: false,
  },
  {
    id: "env-empty-list-name",
    kind: "env-empty-name",
    input: environment(["=foo", "BAR=x=y"]),
    authoring: false,
    runtime: false,
  },
  {
    id: "env-empty-map-name",
    kind: "env-empty-name",
    input: environment({ "": "", BAR: "x=y" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "env-null",
    kind: "env-null-value",
    input: environment({ FOO: null, BAR: "x=y" }),
    authoring: false,
    runtime: false,
  },
  { id: "env-wrong-type", kind: "env-wrong-type", input: environment(5), authoring: false, runtime: false },
  {
    id: "env-list-map-swap",
    kind: "env-list-map-swap",
    input: environment("FOO=bar"),
    authoring: false,
    runtime: false,
  },
  {
    id: "env-map-reserved",
    kind: "env-reserved-name",
    input: environment(JSON.parse('{"__proto__":"x","BAR":"y"}')),
    authoring: false,
    runtime: false,
  },

  // build — bare string / string-slot expressions decode as ordinary strings at runtime
  {
    id: "build-whole",
    kind: "build-expression",
    input: build("{{ recipe.build }}"),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-args-object",
    kind: "build-expression",
    input: build({ args: "{{ { FOO: env.VALUE } }}" }),
    authoring: true,
    runtime: false,
  },
  {
    id: "build-args-list",
    kind: "build-expression",
    input: build({ args: "{{ ['FOO='] }}" }),
    authoring: true,
    runtime: false,
  },
  {
    id: "build-args-value",
    kind: "build-expression",
    input: build({ args: { FOO: "{{ env.VALUE }}" } }),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-artifact",
    kind: "build-expression",
    input: build({ artifact: "{{ recipe.steps }}" }),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-app-step",
    kind: "build-expression",
    input: build({ app: [{ run: "{{ env.STEP }}", user: "{{ env.USER }}" }] }),
    authoring: true,
    runtime: false,
  },
  {
    id: "build-inline",
    kind: "build-expression",
    input: build({ dockerfile_inline: "FROM {{ env.IMAGE }}" }),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-context-string",
    kind: "build-valid",
    input: build("./docker"),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-compose-object",
    kind: "build-valid",
    input: build({ context: ".", dockerfile: "Dockerfile", args: { FOO: "bar" }, target: "base" }),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-script-phases",
    kind: "build-valid",
    input: build({ artifact: "echo artifact", app: ["echo app"] }),
    authoring: true,
    runtime: true,
  },
  {
    id: "build-mixed-expression",
    kind: "build-mixed-families",
    input: build({ app: "{{ recipe.steps }}", context: "." }),
    authoring: false,
    runtime: false,
  },
  {
    id: "build-mixed-literal",
    kind: "build-mixed-families",
    input: build({ app: "echo app", context: "." }),
    authoring: false,
    runtime: false,
  },
  { id: "build-empty", kind: "build-wrong-type", input: build({}), authoring: false, runtime: false },
  {
    id: "build-typo",
    kind: "build-unknown-key",
    input: build({ context: ".", targt: "base" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "build-camel-alias",
    kind: "build-renamed-key",
    input: build({ context: ".", dockerfileInline: "FROM alpine" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "build-unknown-network",
    kind: "build-unknown-key",
    input: build({ context: ".", network: "host" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "build-conflicting-files",
    kind: "build-mixed-families",
    input: build({ dockerfile: "Dockerfile", dockerfile_inline: "FROM nginx" }),
    authoring: false,
    runtime: false,
  },
  { id: "build-wrong-type", kind: "build-wrong-type", input: build(5), authoring: false, runtime: false },
  {
    id: "build-args-bare",
    kind: "env-drop-equals",
    input: build({ context: ".", args: ["FOO"] }),
    authoring: false,
    runtime: false,
  },

  // typed expression slots (authoring-only)
  {
    id: "typed-expr-primary",
    kind: "typed-expression",
    input: service({ primary: "{{ recipe.flag }}" }),
    authoring: true,
    runtime: false,
  },
  {
    id: "typed-expr-port",
    kind: "typed-expression",
    input: { name: "demo", router: { httpPort: "{{ number(env.PORT) }}" } },
    authoring: true,
    runtime: false,
  },
  {
    id: "typed-expr-ports-array",
    kind: "typed-expression",
    input: service({ ports: "{{ recipe.ports }}" }),
    authoring: true,
    runtime: false,
  },

  // renamed / unknown / wrong type (base still accepts Compose aliases via dual spelling)
  {
    id: "renamed-workingDirectory",
    kind: "renamed-key",
    input: service({ workingDirectory: "/app" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "canonical-working_dir",
    kind: "renamed-key",
    input: service({ working_dir: "/app" }),
    authoring: true,
    runtime: true,
  },
  {
    id: "unknown-service-imgae",
    kind: "unknown-key",
    input: service({ imgae: "nginx" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "wrong-primary-type",
    kind: "wrong-literal-type",
    input: service({ primary: "maybe" }),
    authoring: false,
    runtime: false,
  },
  {
    id: "wrong-name-type",
    kind: "wrong-literal-type",
    input: { name: 5 },
    authoring: false,
    runtime: false,
  },

  // ports long-form spellings
  {
    id: "ports-host_ip",
    kind: "ports",
    input: service({
      ports: [{ target: 80, published: 8080, host_ip: "127.0.0.1", protocol: "tcp" }],
    }),
    authoring: true,
    runtime: true,
  },
  {
    id: "ports-hostIp-alias",
    kind: "ports",
    input: service({
      ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }],
    }),
    authoring: false,
    runtime: false,
  },
  {
    id: "ports-null-entry",
    kind: "ports",
    input: service({ ports: [null] }),
    authoring: false,
    runtime: false,
  },
  {
    id: "ports-negative-target",
    kind: "ports",
    input: service({ ports: [{ target: -1 }] }),
    authoring: false,
    runtime: false,
  },
] as const;
