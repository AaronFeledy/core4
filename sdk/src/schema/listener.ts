import { Schema } from "effect";

import { PortNumber } from "./primitives.ts";

// ============================================================================
// Who configures a planned listener, and what they must set.
// ============================================================================

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

const authorityFields = {
  daemon: NonEmptyString.annotate({
    description: "Server whose configuration the owner must supply; never socket attribution.",
  }),
  port: PortNumber.annotate({ description: "Planned listener port." }),
};

export const ListenerAuthority = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("application").annotate({
      description: "Application code or its command owns a language-runtime listener.",
    }),
    ...authorityFields,
    variables: Schema.NonEmptyArray(NonEmptyString).annotate({
      description: "Port environment variables Lando projects from the planned port.",
    }),
  }),
  Schema.Struct({
    owner: Schema.Literal("launcher").annotate({
      description: "An authored command or entrypoint replaced the Lando launcher that set the listener.",
    }),
    ...authorityFields,
    setting: NonEmptyString.annotate({ description: "Launcher argument that sets the planned port." }),
  }),
  Schema.Struct({
    owner: Schema.Literal("image").annotate({
      description: "A custom image or build owns the daemon configuration that sets the listener.",
    }),
    ...authorityFields,
    setting: NonEmptyString.annotate({ description: "Configuration setting for the planned port." }),
    file: Schema.optionalKey(NonEmptyString).annotate({ description: "File that holds the setting." }),
  }),
]).annotate({
  identifier: "ListenerAuthority",
  description: "Who configures a planned listener that Lando does not, and the setting they must supply.",
});
export type ListenerAuthority = typeof ListenerAuthority.Type;

/** One remediation sentence telling the listener's owner what to configure. */
export const formatListenerAuthority = (authority: ListenerAuthority): string => {
  switch (authority.owner) {
    case "application": {
      const variables = authority.variables.map((variable) => `\`${variable}\``);
      const list =
        variables.length < 2
          ? variables.join("")
          : `${variables.slice(0, -1).join(", ")} and ${variables.at(-1)}`;
      return `Make your server listen on 0.0.0.0:${authority.port}; your application owns this listener and Lando sets ${list} to ${authority.port}.`;
    }
    case "launcher":
      return `Pass \`${authority.setting}\` to ${authority.daemon} in your command or entrypoint; Lando sets the listener from port: only in its own launcher.`;
    case "image":
      return `Set \`${authority.setting}\`${authority.file === undefined ? "" : ` in ${authority.file}`} for ${authority.daemon} in your image or build; Lando sets the listener from port: only in configuration it owns.`;
  }
};
