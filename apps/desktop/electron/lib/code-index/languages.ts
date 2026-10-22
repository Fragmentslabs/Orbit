import type { LRParser } from '@lezer/lr'

/**
 * Como cada linguagem vira símbolos. Os parsers são os do Lezer — os mesmos
 * que o editor (CodeMirror) já carrega —, então o índice não traz dependência
 * nativa nenhuma: nada de tree-sitter para recompilar por Electron/arquitetura.
 *
 * Cada regra diz que nó do parser é uma definição e onde está o nome dela. O
 * resto (referências, escopo, assinatura) é o mesmo algoritmo para todas.
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
  /** Tipos de nó que carregam o nome, procurados em pré-ordem sem entrar em corpo/parâmetros. */
  name: string[]
  /** Só é definição se tiver este filho direto (struct de C com corpo, método de C++ declarado). */
  requires?: string
  /** Só fora de corpo de função — variáveis de módulo e de classe, nunca as locais. */
  topLevel?: boolean
  /** Não vira símbolo: só qualifica o que está dentro (o `impl S` do Rust). */
  container?: boolean
  /** O nome é a ÚLTIMA ocorrência, não a primeira (`impl Trait for S` → S). */
  lastName?: boolean
  /** Troca o tipo conforme um filho direto (`const f = () => {}` é função; `type S struct` é classe). */
  kindByChild?: Record<string, SymbolKind>
  /** O escopo vem do primeiro TypeName deste filho (receiver de método Go). */
  receiver?: string
}

export interface LezerSpec {
  id: string
  load: () => Promise<LRParser>
  defs: Record<string, DefRule>
  /** Nós de identificador que contam como uso de um símbolo. */
  refs: Set<string>
  /** Dos refs, os que são acesso a membro (`x.foo`) — só ligam a métodos/campos. */
  members?: Set<string>
  /** Membro quando o pai é um destes (PHP: o Name dentro de `$x->go`). */
  memberParents?: Set<string>
  /** Nós que LIGAM um nome no arquivo (parâmetro, variável local, nome importado). */
  bindings?: Set<string>
  /** Ligação quando o pai é um destes (Python: VariableName dentro de ParamList). */
  bindingParents?: Set<string>
  /** Dos refs, os que são uso de tipo (`: Foo`) — só ligam a classe/interface/tipo. */
  types?: Set<string>
  /** Onde a assinatura termina — e onde a busca do nome não entra. */
  bodies: Set<string>
  /** Também fora da busca do nome (parâmetros, anotações de tipo). */
  skip: Set<string>
  /** Corpos de função: dentro deles, regras `topLevel` não disparam. */
  scopes: Set<string>
  /** Nós de import cujo filho String é o caminho do módulo (JS/TS). */
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

// .ts sem jsx de propósito: em .ts, `<T>(x) => x` é genérico, e com jsx ligado
// o parser leria uma tag.
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
 * Linguagens sem parser Lezer: entram por um extrator de linha (regex). Acha
 * menos (sem escopo fino, sem distinguir string de código), mas põe o arquivo
 * no mapa — uma busca que ignora o app Swift inteiro seria pior.
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

/** Os parsers configurados ficam em cache: configure() cria um novo a cada chamada. */
const parserCache = new Map<string, Promise<LRParser>>()

export function parserFor(spec: LezerSpec): Promise<LRParser> {
  let parser = parserCache.get(spec.id)
  if (!parser) {
    parser = spec.load()
    parserCache.set(spec.id, parser)
  }
  return parser
}
