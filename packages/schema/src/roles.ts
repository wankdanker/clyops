import type { Schema, SchemaBody, SchemaRole } from './types.js';

/**
 * The roles in effect for a command path (spec section 14): the program's and each command's
 * declarations down `path`, the nearest winning for a name, in program-first order. A runner maps
 * the ones it wants in CLYOPS_FDS. Unknown command words end the walk.
 */
export function effectiveRoles(schema: Schema, path: string[] = []): SchemaRole[] {
  const levels: SchemaBody[] = [schema];
  let node: SchemaBody = schema;
  for (const word of path) {
    const next = node.commands?.find((c) => c.name === word);
    if (!next) break;
    levels.push(next);
    node = next;
  }
  const byName = new Map<string, SchemaRole>();
  for (const level of levels) for (const role of level.roles ?? []) byName.set(role.name, { ...role });
  return [...byName.values()];
}

/** The CLYOPS_FDS value for a role-to-descriptor mapping, e.g. { progress: 4 } -> "progress:4". */
export function fdsEnv(mapping: Record<string, number>): string {
  return Object.entries(mapping).map(([name, fd]) => `${name}:${fd}`).join(',');
}
