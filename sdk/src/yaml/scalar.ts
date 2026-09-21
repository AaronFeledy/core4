const SAFE_PLAIN_SCALAR = /^(?!@)[A-Za-z0-9._~:/@+-]+$/u;
const CORE_WORD = /^(?:true|false|null)$/iu;
const CORE_INT = /^[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/u;
const CORE_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/u;
const CORE_INFINITY = /^[-+]?\.(?:inf|Inf|INF)$/u;
const CORE_NAN = /^\.(?:nan|NaN|NAN)$/u;
const INDICATORS = new Set(["-", ":", "?", "---", "..."]);

// A plain YAML key is only safe when it cannot be re-resolved into a different
// node: an allowlist is used rather than a denylist so an unanticipated shape
// fails closed into quotes. Double-quoted form is the escape hatch for every
// other key, and JSON escaping is a valid YAML double-quoted scalar.
const SAFE_PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_./-]*$/u;
const AMBIGUOUS_PLAIN_WORD = /^(?:true|false|null|yes|no|on|off|y|n)$/iu;

export const quoteYamlScalar = (value: string): string => JSON.stringify(value);

export const isYamlPlainSafe = (value: string): boolean =>
  SAFE_PLAIN_SCALAR.test(value) &&
  value !== "~" &&
  !value.endsWith(":") &&
  !CORE_WORD.test(value) &&
  !CORE_INT.test(value) &&
  !CORE_FLOAT.test(value) &&
  !CORE_INFINITY.test(value) &&
  !CORE_NAN.test(value) &&
  !INDICATORS.has(value);

export const yamlScalarText = (value: string): string =>
  isYamlPlainSafe(value) ? value : quoteYamlScalar(value);

export const yamlMappingKeyText = (key: string): string =>
  SAFE_PLAIN_KEY.test(key) && !AMBIGUOUS_PLAIN_WORD.test(key) ? key : quoteYamlScalar(key);
