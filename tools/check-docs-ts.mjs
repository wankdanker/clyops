// Check the actual exports, including re-exports, rather than a handwritten API list.
import ts from 'typescript';
import path from 'node:path';
const config = ts.readConfigFile('docs/tsconfig.json', ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.resolve('docs'));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const seen = new Set();
const missing = [];
function inspect(symbol) {
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (seen.has(symbol)) return;
  seen.add(symbol);
  const declarations = symbol.declarations?.filter(d => !d.getSourceFile().fileName.includes('node_modules')) ?? [];
  if (!declarations.length) return;
  if (!ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()) missing.push(symbol.getName());
  for (const declaration of declarations) {
    if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) continue;
    for (const member of declaration.members) {
      if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
      if (member.name && !ts.isPrivateIdentifier(member.name)) {
        const child = checker.getSymbolAtLocation(member.name);
        if (child) inspect(child);
      } else if (ts.isConstructorDeclaration(member) && !ts.getJSDocCommentsAndTags(member).length) missing.push(`${symbol.getName()}.constructor`);
    }
  }
}
for (const file of ['packages/schema/src/index.ts', 'packages/js/src/index.ts', 'packages/tools/src/index.ts', 'packages/jobs/src/index.ts', 'apps/api/src/index.ts', 'apps/mcp/src/index.ts']) {
  const source = program.getSourceFile(file);
  for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) inspect(symbol);
}
if (missing.length) throw new Error(`Undocumented Node API: ${missing.join(', ')}`);
console.log(`Node API: ${seen.size} exported symbols and members checked.`);
