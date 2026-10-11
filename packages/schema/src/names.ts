import type { SchemaOption, SchemaArgument } from './types.js';

/** The input key for an option or argument name: `dry-run` -> `dry_run`. */
export function inputKey(name: string): string {
  return name.replace(/-/g, '_');
}

/** Input keys accepted for an option or argument, in order of preference. */
export function inputKeys(item: SchemaOption | SchemaArgument): string[] {
  const variable = 'variableName' in item ? item.variableName : item.name;
  return [...new Set([inputKey(item.name), item.name, variable.toLowerCase()])].filter(Boolean);
}

/** True for a flag option, which takes no value on the command line. */
export function isBareFlag(option: SchemaOption): boolean {
  const choices = [...option.choices].sort().join(',');
  return option.isFlag && choices !== 'false,true';
}
