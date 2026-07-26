const buildScriptJsonSchema = {
  oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
} as const;

export const buildBlockJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        artifact: buildScriptJsonSchema,
        app: buildScriptJsonSchema,
      },
      anyOf: [{ required: ["artifact"] }, { required: ["app"] }],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        context: { type: "string" },
        dockerfile: { type: "string" },
        dockerfile_inline: { type: "string" },
        dockerfileInline: { type: "string" },
        args: {
          oneOf: [
            { type: "object", additionalProperties: { type: "string" } },
            { type: "array", items: { type: "string", pattern: "^[^=]+=" } },
          ],
        },
        target: { type: "string" },
      },
      anyOf: [
        { required: ["context"] },
        { required: ["dockerfile"] },
        { required: ["dockerfile_inline"] },
        { required: ["dockerfileInline"] },
        { required: ["args"] },
        { required: ["target"] },
      ],
      allOf: [
        { not: { required: ["dockerfile", "dockerfile_inline"] } },
        { not: { required: ["dockerfile", "dockerfileInline"] } },
        { not: { required: ["dockerfile_inline", "dockerfileInline"] } },
      ],
    },
  ],
} as const;
