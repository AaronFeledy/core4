import { join } from "node:path";

export const resolveUserDataRoot = (): string => {
  if (process.env.LANDO_USER_DATA_ROOT !== undefined) return process.env.LANDO_USER_DATA_ROOT;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : `${process.env.HOME ?? "."}/.local/share`;
  return join(base, "lando");
};

export const resolveUserConfRoot = (): string => {
  if (process.env.LANDO_USER_CONF_ROOT !== undefined) return process.env.LANDO_USER_CONF_ROOT;
  return `${process.env.HOME ?? "."}/.lando`;
};
