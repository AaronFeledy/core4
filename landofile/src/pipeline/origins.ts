import type { ValueOrigins } from "@lando/sdk/landofile";
import type { AuthoredOrigin } from "./prepare.ts";

const origins = new WeakMap<object, ValueOrigins<AuthoredOrigin>>();
export const rememberOrigins = <T extends object>(value: T, source: ValueOrigins<AuthoredOrigin>): T => {
  origins.set(value, source);
  return value;
};
export const getOrigins = (value: object) => origins.get(value);
export const copyOrigins = <T extends object>(from: object, to: T): T => {
  const source = origins.get(from);
  return source === undefined ? to : rememberOrigins(to, source);
};
