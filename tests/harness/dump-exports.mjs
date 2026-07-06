// Usage: node dump-exports.mjs <tsPackageDir> <entryFile> [entryFile...]
// Prints JSON: { entry: [{name, kind, sig, file}] }
import { createRequire } from 'module';
import path from 'path';

const [tsDir, ...entries] = process.argv.slice(2);
const require = createRequire(path.join(tsDir, 'package.json'));
const ts = require('typescript');

const program = ts.createProgram(entries.map(e => path.resolve(e)), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  skipLibCheck: true,
  noEmit: true,
  strict: false,
});
const checker = program.getTypeChecker();

function kindOf(decl) {
  const k = ts.SyntaxKind[decl.kind];
  switch (decl.kind) {
    case ts.SyntaxKind.ClassDeclaration: return 'class';
    case ts.SyntaxKind.InterfaceDeclaration: return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration: return 'type';
    case ts.SyntaxKind.EnumDeclaration: return 'enum';
    case ts.SyntaxKind.FunctionDeclaration: return 'function';
    case ts.SyntaxKind.VariableDeclaration: {
      const init = decl.initializer;
      if (init && (init.kind === ts.SyntaxKind.ArrowFunction || init.kind === ts.SyntaxKind.FunctionExpression)) return 'function(const)';
      return 'const';
    }
    case ts.SyntaxKind.ModuleDeclaration: return 'namespace';
    case ts.SyntaxKind.ExportSpecifier: return 'reexport';
    default: return k;
  }
}

function sigOf(sym, decl) {
  try {
    if (decl.kind === ts.SyntaxKind.FunctionDeclaration || (decl.kind === ts.SyntaxKind.VariableDeclaration)) {
      const t = checker.getTypeOfSymbolAtLocation(sym, decl);
      let s = checker.typeToString(t, decl, ts.TypeFormatFlags.NoTruncation);
      if (s.length > 400) s = s.slice(0, 400) + '…';
      return s;
    }
    if (decl.kind === ts.SyntaxKind.TypeAliasDeclaration) {
      let s = decl.getText().replace(/\s+/g, ' ');
      if (s.length > 400) s = s.slice(0, 400) + '…';
      return s;
    }
    if (decl.kind === ts.SyntaxKind.ClassDeclaration || decl.kind === ts.SyntaxKind.InterfaceDeclaration) {
      // heritage + member names
      const heritage = (decl.heritageClauses || []).map(h => h.getText().replace(/\s+/g, ' ')).join(' ');
      const members = (decl.members || []).map(m => m.name ? m.name.getText() : (m.kind === ts.SyntaxKind.Constructor ? 'constructor' : '?')).filter((v, i, a) => a.indexOf(v) === i);
      let s = (heritage ? heritage + ' ' : '') + '{ ' + members.join(', ') + ' }';
      if (s.length > 600) s = s.slice(0, 600) + '…';
      return s;
    }
    if (decl.kind === ts.SyntaxKind.EnumDeclaration) {
      return '{ ' + decl.members.map(m => m.name.getText()).join(', ') + ' }';
    }
  } catch (e) { return 'ERR:' + e.message; }
  return '';
}

const out = {};
for (const entry of entries) {
  const sf = program.getSourceFile(path.resolve(entry));
  if (!sf) { out[entry] = { error: 'source file not found' }; continue; }
  const modSym = checker.getSymbolAtLocation(sf);
  if (!modSym) { out[entry] = { error: 'no module symbol' }; continue; }
  const exports = checker.getExportsOfModule(modSym);
  const rows = [];
  for (const ex of exports) {
    let sym = ex;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch {}
    }
    const decls = sym.declarations || ex.declarations || [];
    const decl = decls[0];
    let file = '', line = 0, kind = 'unknown', sig = '';
    if (decl) {
      const dsf = decl.getSourceFile();
      file = path.relative(process.cwd(), dsf.fileName);
      line = dsf.getLineAndCharacterOfPosition(decl.getStart()).line + 1;
      kind = kindOf(decl);
      sig = sigOf(sym, decl);
    }
    // types-only vs value
    const isType = !!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) && !(sym.flags & ts.SymbolFlags.Value);
    rows.push({ name: ex.name, kind, typeOnly: isType, file, line, sig });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  out[entry] = rows;
}
console.log(JSON.stringify(out, null, 1));
