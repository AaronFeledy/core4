import { Context } from "effect";

export class RuntimeCwd extends Context.Service<RuntimeCwd, string>()("@lando/engine/RuntimeCwd") {}
