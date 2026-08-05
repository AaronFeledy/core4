export type FlagConfig<T> = {
  readonly aliases?: readonly string[];
  readonly char?: string;
  readonly default?: T;
  readonly description?: string;
  readonly helpValue?: string;
  readonly multiple?: boolean;
  readonly options?: readonly string[];
  readonly parse?: (input: string) => T | Promise<T>;
  readonly required?: boolean;
};

export type OptionFlag<T = string | number | undefined> = FlagConfig<T> & {
  readonly multiple: boolean;
  readonly type: "option";
};

export type BooleanFlag<T = boolean | undefined> = FlagConfig<T> & {
  readonly type: "boolean";
};

export type FlagDefinition = OptionFlag | BooleanFlag;
export type FlagDefinitions = Readonly<Record<string, FlagDefinition>>;

export type ArgConfig = {
  readonly description?: string;
  readonly ignoreStdin?: boolean;
  readonly name?: string;
  readonly required?: boolean;
};

export type ArgDefinition = ArgConfig & {
  readonly type: "option";
};

export type ArgDefinitions = Readonly<Record<string, ArgDefinition>>;

export const Flags = {
  string: <T extends string = string>(config: FlagConfig<T> = {}): OptionFlag<T | undefined> => ({
    ...config,
    multiple: config.multiple ?? false,
    type: "option",
  }),
  integer: (config: FlagConfig<number> = {}): OptionFlag<number | undefined> => ({
    ...config,
    multiple: config.multiple ?? false,
    type: "option",
  }),
  boolean: (config: FlagConfig<boolean> = {}): BooleanFlag<boolean | undefined> => ({
    ...config,
    type: "boolean",
  }),
} as const;

export const Args = {
  string: (config: ArgConfig = {}): ArgDefinition => ({ ...config, type: "option" }),
} as const;

export type ParsedCommand = {
  readonly args: Record<string, unknown>;
  readonly argv: readonly string[];
  readonly flags: Record<string, unknown>;
};

export type CommandClass = typeof Command;

function runLegacyCommand(this: CommandClass, argv: readonly string[] = []): Promise<void> {
  const instance: unknown = Reflect.construct(this, [argv]);
  if (!(instance instanceof Command)) {
    return Promise.reject(new TypeError("Legacy command metadata produced an invalid command instance."));
  }
  return instance.run();
}

export abstract class Command {
  static aliases: readonly string[] = [];
  static args: ArgDefinitions = {};
  static baseFlags: FlagDefinitions = {};
  static description = "";
  static flags: FlagDefinitions = {};
  static hidden = false;
  static strict = true;
  static summary: string | undefined = undefined;
  static readonly run = runLegacyCommand;

  argv: string[];
  readonly ctor: CommandClass;
  readonly id?: string;

  constructor(argv: readonly string[] = []) {
    this.argv = [...argv];
    const commandClass: unknown = this.constructor;
    if (!isCommandClass(commandClass)) {
      throw new TypeError("Legacy command metadata has an invalid command constructor.");
    }
    this.ctor = commandClass;
  }

  parse(_command: CommandClass): Promise<ParsedCommand> {
    return Promise.resolve({ args: {}, argv: this.argv, flags: {} });
  }

  abstract run(): Promise<void>;
}

const isCommandClass = (value: unknown): value is CommandClass =>
  typeof value === "function" && typeof Reflect.get(value, "run") === "function";

export type Manifest = {
  readonly commands: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly version: string;
};

type HookCommand = {
  readonly load: () => Promise<CommandClass>;
};

type HookConfig = {
  readonly findCommand: (id: string) => HookCommand | undefined;
};

type HookContext = {
  readonly error: (message: string, options: { readonly code: string; readonly exit: number }) => never;
  readonly exit: (code: number) => never;
};

type HookOptionsBase = {
  readonly config: HookConfig;
  readonly context: HookContext;
};

type InitHookOptions = HookOptionsBase & {
  readonly argv: readonly string[];
  readonly id?: string;
};

type CommandNotFoundHookOptions = HookOptionsBase & {
  readonly argv?: readonly string[];
  readonly id: string;
};

export type HookOptions<Name extends string> = Name extends "init"
  ? InitHookOptions
  : Name extends "command_not_found"
    ? CommandNotFoundHookOptions
    : HookOptionsBase;

export type Hook<Name extends string> = (options: HookOptions<Name>) => Promise<void>;
