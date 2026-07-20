export type HighlightToken = {
  text: string
  color?: string
}

export type SyntaxPalette = {
  foreground: string
  comment: string
  keyword: string
  string: string
  number: string
  function: string
  type: string
  operator: string
  punctuation: string
  property: string
  regex: string
  escape: string
}

export const darkSyntaxPalette: SyntaxPalette = {
  foreground: '#e6edf3',
  comment: '#8b949e',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  function: '#d2a8ff',
  type: '#ffa657',
  operator: '#ff7b72',
  punctuation: '#e6edf3',
  property: '#79c0ff',
  regex: '#a5d6ff',
  escape: '#79c0ff',
}

export const lightSyntaxPalette: SyntaxPalette = {
  foreground: '#1f2328',
  comment: '#6e7781',
  keyword: '#cf222e',
  string: '#0a3069',
  number: '#0550ae',
  function: '#8250df',
  type: '#953800',
  operator: '#cf222e',
  punctuation: '#1f2328',
  property: '#0550ae',
  regex: '#0a3069',
  escape: '#0550ae',
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  cs: 'csharp',
  'c++': 'cpp',
  'c#': 'csharp',
  htaccess: 'apache',
  dockerfile: 'docker',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
}

const KEYWORDS: Record<string, string[]> = {
  javascript: [
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
    'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield', 'enum', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'readonly', 'type', 'namespace', 'abstract', 'declare',
    'module', 'require', 'of',
  ],
  typescript: [
    'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
    'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield', 'enum', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'readonly', 'type', 'namespace', 'abstract', 'declare',
    'module', 'keyof', 'infer', 'is', 'asserts', 'satisfies', 'override',
  ],
  python: [
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
    'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
    'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
    'try', 'while', 'with', 'yield', 'match', 'case',
  ],
  rust: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
    'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
    'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
    'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'abstract', 'become',
    'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield',
  ],
  go: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
    'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
    'return', 'select', 'struct', 'switch', 'type', 'var', 'true', 'false', 'nil', 'iota',
  ],
  java: [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
    'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
    'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
    'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
    'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
    'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
  ],
  csharp: [
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked',
    'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else',
    'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
    'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock',
    'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params',
    'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
    'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw',
    'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using',
    'virtual', 'void', 'volatile', 'while', 'var', 'async', 'await', 'nameof', 'when',
  ],
  ruby: [
    'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else',
    'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not',
    'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef',
    'unless', 'until', 'when', 'while', 'yield',
  ],
  php: [
    'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone',
    'const', 'continue', 'declare', 'default', 'die', 'do', 'echo', 'else', 'elseif', 'empty',
    'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'eval', 'exit',
    'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if',
    'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset',
    'list', 'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public',
    'readonly', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait',
    'try', 'unset', 'use', 'var', 'while', 'xor', 'yield', 'true', 'false', 'null',
  ],
  bash: [
    'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until',
    'do', 'done', 'in', 'function', 'time', 'coproc', 'true', 'false',
  ],
  sql: [
    'select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'values', 'update', 'set',
    'delete', 'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'inner', 'left',
    'right', 'outer', 'on', 'as', 'order', 'by', 'group', 'having', 'limit', 'offset',
    'union', 'all', 'distinct', 'null', 'is', 'in', 'like', 'between', 'exists', 'case',
    'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default',
    'constraint', 'unique', 'check', 'asc', 'desc', 'with', 'recursive',
  ],
  kotlin: [
    'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in',
    'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw',
    'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while', 'by', 'catch',
    'constructor', 'delegate', 'dynamic', 'field', 'file', 'finally', 'get', 'import',
    'init', 'param', 'property', 'receiver', 'set', 'setparam', 'where', 'actual', 'abstract',
    'annotation', 'companion', 'const', 'crossinline', 'data', 'enum', 'expect', 'external',
    'final', 'infix', 'inline', 'inner', 'internal', 'lateinit', 'noinline', 'open', 'operator',
    'out', 'override', 'private', 'protected', 'public', 'reified', 'sealed', 'suspend',
    'tailrec', 'vararg',
  ],
  swift: [
    'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import',
    'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public',
    'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'continue',
    'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat',
    'return', 'switch', 'where', 'while', 'as', 'Any', 'catch', 'false', 'is', 'nil', 'super',
    'self', 'Self', 'throw', 'throws', 'true', 'try', 'async', 'await', 'actor',
  ],
  css: [
    'important', 'from', 'to',
  ],
}

const TYPES: Record<string, string[]> = {
  typescript: [
    'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'object', 'symbol',
    'bigint', 'Promise', 'Array', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
    'Map', 'Set', 'Date', 'Error', 'RegExp', 'Function',
  ],
  javascript: [
    'Promise', 'Array', 'Map', 'Set', 'Date', 'Error', 'RegExp', 'Function', 'Object',
    'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'JSON', 'Math', 'console',
  ],
  python: [
    'int', 'float', 'str', 'bool', 'list', 'dict', 'tuple', 'set', 'bytes', 'NoneType',
    'Optional', 'Union', 'List', 'Dict', 'Tuple', 'Set', 'Any', 'Callable',
  ],
  rust: [
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc',
  ],
  go: [
    'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8',
    'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'uintptr',
  ],
  java: [
    'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte', 'Short',
    'Object', 'List', 'Map', 'Set', 'Optional', 'ArrayList', 'HashMap', 'HashSet',
  ],
  csharp: [
    'string', 'int', 'long', 'float', 'double', 'bool', 'byte', 'char', 'decimal', 'object',
    'dynamic', 'var', 'void', 'Task', 'List', 'Dictionary', 'IEnumerable', 'Action', 'Func',
  ],
  kotlin: [
    'Any', 'Unit', 'String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'Byte',
    'Short', 'List', 'Map', 'Set', 'Array', 'Nothing',
  ],
  swift: [
    'String', 'Int', 'Double', 'Float', 'Bool', 'Character', 'Array', 'Dictionary', 'Set',
    'Optional', 'Any', 'AnyObject', 'Void',
  ],
}

type Rule = { type: keyof SyntaxPalette | 'foreground'; regex: RegExp }

function buildRules(language: string): Rule[] {
  const keywords = KEYWORDS[language] ?? []
  const types = TYPES[language] ?? []
  const rules: Rule[] = []

  if (language === 'json') {
    return [
      { type: 'comment', regex: /\/\/[^\n]*/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
      { type: 'keyword', regex: /\b(?:true|false|null)\b/y },
      { type: 'punctuation', regex: /[{}\[\]:,]/y },
    ]
  }

  if (language === 'markdown') {
    return [
      { type: 'keyword', regex: /^#{1,6}\s+.*/my },
      { type: 'string', regex: /`{1,3}[^`]*`{1,3}/y },
      { type: 'keyword', regex: /\*\*[^*]+\*\*/y },
      { type: 'keyword', regex: /\*[^*]+\*/y },
      { type: 'property', regex: /\[[^\]]+\]\([^)]+\)/y },
      { type: 'comment', regex: /^>\s+.*/my },
    ]
  }

  if (language === 'css' || language === 'scss') {
    return [
      { type: 'comment', regex: /\/\*[\s\S]*?\*\//y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'property', regex: /#[0-9a-fA-F]{3,8}\b/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/y },
      { type: 'keyword', regex: /@[a-zA-Z-]+\b/y },
      { type: 'function', regex: /\b[a-zA-Z_-][\w-]*(?=\()/y },
      { type: 'property', regex: /--[\w-]+/y },
      { type: 'type', regex: /\.[a-zA-Z_-][\w-]*/y },
      { type: 'keyword', regex: /\b(?:important|from|to)\b/y },
      { type: 'punctuation', regex: /[{}();:,.!]/y },
      { type: 'operator', regex: /[+\-*/%=<>!&|^~?]+/y },
    ]
  }

  if (language === 'html' || language === 'xml' || language === 'svg') {
    return [
      { type: 'comment', regex: /<!--[\s\S]*?-->/y },
      { type: 'keyword', regex: /<\/?[a-zA-Z][\w:-]*/y },
      { type: 'property', regex: /\s[a-zA-Z_:][\w:.-]*(?==)/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'punctuation', regex: /[=/<>]/y },
    ]
  }

  if (language === 'yaml') {
    return [
      { type: 'comment', regex: /#[^\n]*/y },
      { type: 'property', regex: /^[ \t]*[\w.-]+(?=\s*:)/my },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?\b/y },
      { type: 'keyword', regex: /\b(?:true|false|null|yes|no|on|off)\b/y },
      { type: 'punctuation', regex: /[:\-{}[\],|>]/y },
    ]
  }

  if (language === 'bash' || language === 'powershell' || language === 'shell') {
    return [
      { type: 'comment', regex: /#[^\n]*/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'string', regex: /`(?:\\.|[^`\\])*`/y },
      { type: 'property', regex: /\$\{?[\w@*#?$!-]+\}?/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?\b/y },
      { type: 'keyword', regex: keywords.length ? new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'y') : /(?!)/y },
      { type: 'function', regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
      { type: 'operator', regex: /&&|\|\||[|><&;]+/y },
      { type: 'punctuation', regex: /[{}()[\],.]/y },
    ]
  }

  if (language === 'sql') {
    return [
      { type: 'comment', regex: /--[^\n]*|\/\*[\s\S]*?\*\//y },
      { type: 'string', regex: /'(?:''|[^'])*'/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?\b/y },
      { type: 'keyword', regex: keywords.length ? new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'iy') : /(?!)/y },
      { type: 'function', regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
      { type: 'punctuation', regex: /[(),.;*]/y },
      { type: 'operator', regex: /[=<>!]+/y },
    ]
  }

  // default C-like / general languages
  rules.push(
    { type: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: 'comment', regex: /#[^\n]*/y },
    { type: 'string', regex: /"""[\s\S]*?"""|'''[\s\S]*?'''/y },
    { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y },
    { type: 'regex', regex: /\/(?:\\.|[^/\\\n])+\/[gimsuy]*/y },
    { type: 'number', regex: /-?\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y },
  )

  if (keywords.length) {
    rules.push({ type: 'keyword', regex: new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'y') })
  }
  if (types.length) {
    rules.push({ type: 'type', regex: new RegExp(`\\b(?:${types.join('|')})\\b`, 'y') })
  }

  rules.push(
    { type: 'function', regex: /\b[a-zA-Z_]\w*(?=\s*\()/y },
    { type: 'property', regex: /\b[a-zA-Z_]\w*(?=\s*:)/y },
    { type: 'operator', regex: /[+\-*/%=<>!&|^~?:]+|\.{2,3}/y },
    { type: 'punctuation', regex: /[{}()[\];,.]/y },
  )

  return rules
}

function normalizeLanguage(language?: string): string {
  const raw = (language ?? '').trim().toLowerCase()
  if (!raw) return 'plaintext'
  return LANGUAGE_ALIASES[raw] ?? raw
}

export function highlightCode(
  code: string,
  language?: string,
  palette: SyntaxPalette = darkSyntaxPalette,
): HighlightToken[] {
  if (!code) return []

  const lang = normalizeLanguage(language)
  if (lang === 'plaintext' || lang === 'text') {
    return [{ text: code, color: palette.foreground }]
  }

  const rules = buildRules(lang)
  const tokens: HighlightToken[] = []
  let i = 0

  while (i < code.length) {
    let matched = false

    for (const rule of rules) {
      rule.regex.lastIndex = i
      const match = rule.regex.exec(code)
      if (!match || match.index !== i) continue

      const text = match[0]
      if (!text) continue

      tokens.push({
        text,
        color: palette[rule.type] ?? palette.foreground,
      })
      i += text.length
      matched = true
      break
    }

    if (!matched) {
      const start = i
      i += 1
      while (i < code.length) {
        let hit = false
        for (const rule of rules) {
          rule.regex.lastIndex = i
          const match = rule.regex.exec(code)
          if (match && match.index === i) {
            hit = true
            break
          }
        }
        if (hit) break
        i += 1
      }
      tokens.push({ text: code.slice(start, i), color: palette.foreground })
    }
  }

  return mergeAdjacent(tokens)
}

function mergeAdjacent(tokens: HighlightToken[]): HighlightToken[] {
  if (tokens.length === 0) return tokens
  const out: HighlightToken[] = [{ ...tokens[0] }]
  for (let i = 1; i < tokens.length; i++) {
    const prev = out[out.length - 1]
    const cur = tokens[i]
    if (prev.color === cur.color) {
      prev.text += cur.text
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

export function displayLanguage(language?: string): string {
  const lang = normalizeLanguage(language)
  if (lang === 'plaintext') return 'text'
  return lang
}
