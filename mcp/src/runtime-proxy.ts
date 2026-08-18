import { types } from "node:util";

export const isRuntimeProxy = (value: object): boolean => types.isProxy(value);
