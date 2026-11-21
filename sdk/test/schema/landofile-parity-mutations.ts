const service = (fields: object) => ({ name: "demo", services: { web: { type: "node:22", ...fields } } });
const environment = (value: unknown) => service({ environment: value });
const build = (value: unknown) => service({ build: value });

export const publicationMutations = [
  { id: "env-list", input: environment(["FOO=", "BAR=x=y"]), accepted: true },
  { id: "env-map", input: environment({ FOO: "", BAR: "x=y" }), accepted: true },
  { id: "env-bare", input: environment(["FOO", "BAR=x=y"]), accepted: false },
  { id: "env-reserved", input: environment(["__proto__=", "BAR=x=y"]), accepted: false },
  { id: "env-empty-list-name", input: environment(["=foo", "BAR=x=y"]), accepted: false },
  { id: "env-empty-map-name", input: environment({ "": "", BAR: "x=y" }), accepted: false },
  { id: "env-null", input: environment({ FOO: null, BAR: "x=y" }), accepted: false },
  { id: "build-whole", input: build("{{ recipe.build }}"), accepted: true },
  { id: "build-args-object", input: build({ args: "{{ { FOO: env.VALUE } }}" }), accepted: true },
  { id: "build-args-list", input: build({ args: "{{ ['FOO='] }}" }), accepted: true },
  { id: "build-args-value", input: build({ args: { FOO: "{{ env.VALUE }}" } }), accepted: true },
  { id: "build-artifact", input: build({ artifact: "{{ recipe.steps }}" }), accepted: true },
  {
    id: "build-app-step",
    input: build({ app: [{ run: "{{ env.STEP }}", user: "{{ env.USER }}" }] }),
    accepted: true,
  },
  { id: "build-inline", input: build({ dockerfile_inline: "FROM {{ env.IMAGE }}" }), accepted: true },
  {
    id: "build-mixed-expression",
    input: build({ app: "{{ recipe.steps }}", context: "." }),
    accepted: false,
  },
  { id: "build-typo", input: build({ context: ".", targt: "base" }), accepted: false },
  {
    id: "build-camel-alias",
    input: build({ context: ".", dockerfileInline: "FROM alpine" }),
    accepted: false,
  },
] as const;
