import type { Schema, SchemaBody, SchemaFd } from './types.js';

/**
 * The file descriptors in effect for a command path (spec section 14): the program's and each
 * command's declarations down `path`, the nearest winning for a descriptor number. An inherited
 * descriptor whose role a nearer level redeclares keeps its number but loses the role, as the
 * libraries' `emit(role)` no longer reaches it. Unknown command words end the walk.
 */
export function effectiveFds(schema: Schema, path: string[] = []): SchemaFd[] {
  const levels: SchemaBody[] = [schema];
  let node: SchemaBody = schema;
  for (const word of path) {
    const next = node.commands?.find((c) => c.name === word);
    if (!next) break;
    levels.push(next);
    node = next;
  }
  const out: SchemaFd[] = [];
  for (const level of levels.reverse()) {
    for (const decl of level.fds ?? []) {
      if (out.some((d) => d.fd === decl.fd)) continue;
      const shadowed = decl.role !== '' && out.some((d) => d.role === decl.role);
      out.push(shadowed ? { ...decl, role: '' } : { ...decl });
    }
  }
  return out.sort((a, b) => a.fd - b.fd);
}
