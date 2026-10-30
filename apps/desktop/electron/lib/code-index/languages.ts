import type { LRParser } from '@lezer/lr'

/**
 * How each language becomes symbols. The parsers are the Lezer ones — the same
 * ones the editor (CodeMirror) already loads —, so the index brings no native
 * dependency at all: no tree-sitter to recompile per Electron/architecture.
 *
 * Each rule says which parser node is a definition and where its name is. The
 * rest (references, scope, signature) is the same algorithm for all of them.
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'module'

export interface DefRule {
  kind: SymbolKind
  /** Node types that carry the name, looked up in pre-order without entering body/parameters. */
  name: string[]
  /** It is only a definition if it has this direct child (C struct with a body, declared C++ method). */
  requires?: string
  /** Only outside a function body — module and class variables, never the local ones. */
  topLevel?: boolean
  /** Does not become a symbol: it only qualifies what is inside (the Rust `impl S`). */
  container?: boolean
  /** The name is the LAST occurrence, not the first (`impl Trait for S` → S). */
  lastName?: boolean
  /** Changes the kind according to a direct child (`const f = () => {}` is a function; `type S struct` is a class). */
  kindByChild?: Record<string, SymbolKind>
  /** The scope comes from the first TypeName of this child (Go method receiver). */
  receiver?: string
}

export interface LezerSpec {
  id: string
  load: () => Promise<LRParser>
  defs: Record<string, DefRule>
  /** Identifier nodes that count as a use of a symbol. */
  refs: Set<string>
  /** Of the refs, the ones that are member access (`x.foo`) — they only link to methods/fields. */
  members?: Set<string>
  /** Member when the parent is one of these (PHP: the Name inside `$x->go`). */
  memberParents?: Set<string>
  /** Nodes that BIND a name in the file (parameter, local variable, imported name). */
  bindings?: Set<string>
  /** Binding when the parent is one of these (Python: VariableName inside ParamList). */
  bindingParents?: Set<string>
  /** Of the refs, the ones that are type uses (`: Foo`) — they only link to class/interface/type. */
  types?: Set<string>
  /** Where the signature ends — and where the name search does not enter. */
  bodies: Set<string>
  /** Also outside the name search (parameters, type annotations). */
  skip: Set<string>
  /** Function bodies: inside them, `topLevel` rules do not fire. */
  scopes: Set<string>
  /** Import nodes whose String child is the module path (JS/TS). */
  imports?: Set<string>
}

const set = (...items: string[]) => new Set(items)

function jsSpec(id: string, dialect: string): LezerSpec {
  return {
    id,
    load: async () => (await import('@lezer/javascript')).parser.configure({ dialect }),
    defs: {
      FunctionDeclaration: { kind: 'function', name: ['VariableDefinition'] },
      ClassDeclaration: { kind: 'class', name: ['VariableDefinition'] },
      InterfaceDeclaration: { kind: 'interface', name: ['TypeDefinition'] },
      TypeAliasDeclaration: { kind: 'type', name: ['TypeDefinition'] },
      EnumDeclaration: { kind: 'enum', name: ['TypeDefinition'] },
      MethodDeclaration: { kind: 'method', name: ['PropertyDefinition', 'PrivatePropertyDefinition'] },
      PropertyDeclaration: {
        kind: 'method',
        name: ['PropertyDefinition', 'PrivatePropertyDefinition'],
        requires: 'ArrowFunction',
      },
      VariableDeclaration: {
        kind: 'variable',
        name: ['VariableDefinition'],
        topLevel: true,
        kindByChild: { ArrowFunction: 'function', FunctionExpression: 'function', ClassExpression: 'class' },
      },
    },
    refs: set('VariableName', 'PropertyName', 'TypeName'),
    members: set('PropertyName'),
    types: set('TypeName'),
    bindings: set('VariableDefinition'),
    bodies: set('Block', 'ClassBody', 'ObjectType', 'EnumBody', 'ObjectExpression', 'ArrayExpression'),
    skip: set('ParamList', 'TypeAnnotation', 'TypeParamList', 'ArgList', 'ArrowFunction', 'FunctionExpression'),
    scopes: set('FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration'),
    imports: set('ImportDeclaration', 'ExportDeclaration'),
  }
}

const python: LezerSpec = {
  id: 'python',
  load: async () => (await import('@lezer/python')).parser,
  defs: {
    FunctionDefinition: { kind: 'function', name: ['VariableName'] },
    ClassDefinition: { kind: 'class', name: ['VariableName'] },
    AssignStatement: { kind: 'variable', name: ['VariableName'], topLevel: true },
  },
  refs: set('VariableName', 'PropertyName'),
  members: set('PropertyName'),
  bindingParents: set('ParamList'),
  bodies: set('Body'),
  skip: set('ParamList', 'ArgList', 'TypeDef'),
  scopes: set('FunctionDefinition', 'LambdaExpression'),
}

const go: LezerSpec = {
  id: 'go',
  load: async () => (await import('@lezer/go')).parser,
  defs: {
    FunctionDecl: { kind: 'function', name: ['DefName'] },
    MethodDecl: { kind: 'method', name: ['FieldName'], receiver: 'Parameters' },
    TypeSpec: {
      kind: 'type',
      name: ['DefName'],
      kindByChild: { StructType: 'class', InterfaceType: 'interface' },
    },
    VarSpec: { kind: 'variable', name: ['DefName'], topLevel: true },
    ConstSpec: { kind: 'variable', name: ['DefName'], topLevel: true },
  },
  refs: set('VariableName', 'FieldName', 'TypeName'),
  members: set('FieldName'),
  types: set('TypeName'),
  bindings: set('DefName'),
  bodies: set('Block', 'StructBody', 'InterfaceBody'),
  skip: set('Parameters', 'TypeParams'),
  scopes: set('FunctionDecl', 'MethodDecl', 'FunctionLiteral'),
}

const rust: LezerSpec = {
  id: 'rust',
  load: async () => (await import('@lezer/rust')).parser,
  defs: {
    FunctionItem: { kind: 'function', name: ['BoundIdentifier'] },
    StructItem: { kind: 'class', name: ['TypeIdentifier'] },
    EnumItem: { kind: 'enum', name: ['TypeIdentifier'] },
    TraitItem: { kind: 'interface', name: ['TypeIdentifier'] },
    TypeItem: { kind: 'type', name: ['TypeIdentifier'] },
    ImplItem: { kind: 'class', name: ['TypeIdentifier'], container: true, lastName: true },
    ConstItem: { kind: 'variable', name: ['BoundIdentifier'] },
    StaticItem: { kind: 'variable', name: ['BoundIdentifier'] },
    ModItem: { kind: 'module', name: ['BoundIdentifier'] },
  },
  refs: set('Identifier', 'FieldIdentifier', 'TypeIdentifier'),
  members: set('FieldIdentifier'),
  types: set('TypeIdentifier'),
  bindings: set('BoundIdentifier'),
  bodies: set('Block', 'DeclarationList', 'FieldDeclarationList', 'EnumVariantList'),
  skip: set('ParamList', 'TypeParamList', 'TypeArgList'),
  scopes: set('FunctionItem', 'ClosureExpression'),
}

const java: LezerSpec = {
  id: 'java',
  load: async () => (await import('@lezer/java')).parser,
  defs: {
    ClassDeclaration: { kind: 'class', name: ['Definition'] },
    RecordDeclaration: { kind: 'class', name: ['Definition'] },
    InterfaceDeclaration: { kind: 'interface', name: ['Definition'] },
    EnumDeclaration: { kind: 'enum', name: ['Definition'] },
    MethodDeclaration: { kind: 'method', name: ['Definition'] },
    ConstructorDeclaration: { kind: 'method', name: ['Definition'] },
    FieldDeclaration: { kind: 'variable', name: ['Definition'], topLevel: true },
  },
  refs: set('Identifier', 'TypeName'),
  types: set('TypeName'),
  bindings: set('Definition'),
  bodies: set('ClassBody', 'InterfaceBody', 'EnumBody', 'Block', 'ConstructorBody'),
  skip: set('FormalParameters', 'TypeParameters'),
  scopes: set('MethodDeclaration', 'ConstructorDeclaration', 'LambdaExpression'),
}

const cpp: LezerSpec = {
  id: 'cpp',
  load: async () => (await import('@lezer/cpp')).parser,
  defs: {
    FunctionDefinition: { kind: 'function', name: ['Identifier', 'FieldIdentifier', 'DestructorName', 'OperatorName'] },
    ClassSpecifier: { kind: 'class', name: ['TypeIdentifier'], requires: 'FieldDeclarationList' },
    StructSpecifier: { kind: 'class', name: ['TypeIdentifier'], requires: 'FieldDeclarationList' },
    UnionSpecifier: { kind: 'class', name: ['TypeIdentifier'], requires: 'FieldDeclarationList' },
    EnumSpecifier: { kind: 'enum', name: ['TypeIdentifier'], requires: 'EnumeratorList' },
    FieldDeclaration: { kind: 'method', name: ['FieldIdentifier', 'Identifier'], requires: 'FunctionDeclarator' },
    Declaration: { kind: 'function', name: ['Identifier'], requires: 'FunctionDeclarator', topLevel: true },
    NamespaceDefinition: { kind: 'module', name: ['Identifier'] },
  },
  refs: set('Identifier', 'FieldIdentifier', 'TypeIdentifier'),
  members: set('FieldIdentifier'),
  types: set('TypeIdentifier'),
  bodies: set('CompoundStatement', 'FieldDeclarationList', 'EnumeratorList'),
  skip: set('ParameterList', 'TemplateParameterList', 'BaseClassClause'),
  scopes: set('FunctionDefinition', 'LambdaExpression'),
}

const php: LezerSpec = {
  id: 'php',
  load: async () => (await import('@lezer/php')).parser,
  defs: {
    FunctionDefinition: { kind: 'function', name: ['Name'] },
    ClassDeclaration: { kind: 'class', name: ['Name'] },
    InterfaceDeclaration: { kind: 'interface', name: ['Name'] },
    TraitDeclaration: { kind: 'class', name: ['Name'] },
    EnumDeclaration: { kind: 'enum', name: ['Name'] },
    MethodDeclaration: { kind: 'method', name: ['Name'] },
  },
  refs: set('Name'),
  memberParents: set('MemberExpression', 'ScopedCallExpression'),
  bodies: set('Block', 'DeclarationList'),
  skip: set('ParamList', 'BaseClause'),
  scopes: set('FunctionDefinition', 'MethodDeclaration', 'ArrowFunction', 'AnonymousFunction'),
}

const BY_EXTENSION: Record<string, LezerSpec> = {}
const register = (spec: LezerSpec, exts: string[]) => exts.forEach((ext) => (BY_EXTENSION[ext] = spec))

// .ts without jsx on purpose: in .ts, `<T>(x) => x` is generic, and with jsx on
// the parser would read a tag.
register(jsSpec('typescript', 'ts'), ['.ts', '.mts', '.cts'])
register(jsSpec('tsx', 'ts jsx'), ['.tsx'])
register(jsSpec('javascript', 'jsx'), ['.js', '.jsx', '.mjs', '.cjs'])
register(python, ['.py', '.pyi'])
register(go, ['.go'])
register(rust, ['.rs'])
register(java, ['.java'])
register(cpp, ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'])
register(php, ['.php'])

/**
 * Languages without a Lezer parser: they come in through a line extractor (regex). It finds
 * less (no fine scope, no telling a string from code), but it puts the file
 * on the map — a search that ignores the whole Swift app would be worse.
 */
const LINE_LANGUAGES: Record<string, string> = {
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.scala': 'scala',
  '.dart': 'dart',
  '.lua': 'lua',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.m': 'objc',
  '.mm': 'objc',
}

export type LanguageHandler = { type: 'lezer'; spec: LezerSpec } | { type: 'line'; id: string }

export function languageFor(ext: string): LanguageHandler | null {
  const lower = ext.toLowerCase()
  const spec = BY_EXTENSION[lower]
  if (spec) return { type: 'lezer', spec }
  const id = LINE_LANGUAGES[lower]
  return id ? { type: 'line', id } : null
}

/** The configured parsers are cached: configure() creates a new one on every call. */
const parserCache = new Map<string, Promise<LRParser>>()

export function parserFor(spec: LezerSpec): Promise<LRParser> {
  let parser = parserCache.get(spec.id)
  if (!parser) {
    parser = spec.load()
    parserCache.set(spec.id, parser)
  }
  return parser
}
