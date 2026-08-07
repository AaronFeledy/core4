import { Context } from "effect";

export class RuntimeCwd extends Context.Tag("@lando/core/RuntimeCwd")<RuntimeCwd, string>() {}
