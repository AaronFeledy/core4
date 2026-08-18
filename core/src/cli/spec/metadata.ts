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
  readonly valueType?: "string" | "integer";
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
    valueType: "integer",
  }),
  boolean: (config: FlagConfig<boolean> = {}): BooleanFlag<boolean | undefined> => ({
    ...config,
    type: "boolean",
  }),
} as const;

export const Args = {
  string: (config: ArgConfig = {}): ArgDefinition => ({ ...config, type: "option" }),
} as const;
