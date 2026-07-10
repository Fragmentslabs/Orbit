import type { Skill, SkillSource } from '../../../shared/skills'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '')
}

export function parseSkill(
  raw: string,
  source: SkillSource,
  filePath: string,
): Skill | null {
  const match = FRONTMATTER.exec(raw)
  if (!match) return null

  const fields: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s/.test(line)) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    let value = line.slice(idx + 1).trim()
    // Blocos YAML multiline (description: > / >- / | / |-): consome as linhas
    // indentadas seguintes — folded (>) junta com espaço, literal (|) com \n
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s/.test(lines[i + 1]))) {
        i++
        if (lines[i].trim()) block.push(lines[i].trim())
      }
      value = value.startsWith('>') ? block.join(' ') : block.join('\n')
    }
    fields[key] = value
  }

  const name = fields.name ? parseValue(fields.name) : ''
  if (!name) return null

  const rawSlug = fields.slug ? parseValue(fields.slug) : ''
  const slug = rawSlug ? sanitizeSlug(rawSlug) : sanitizeSlug(name)

  return {
    name,
    description: fields.description ? parseValue(fields.description) : '',
    slug,
    content: raw.slice(match[0].length).trim(),
    source,
    filePath,
  }
}

/** snake_case seguro para referência @slug */
export function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/** Serializa uma skill para o formato .skill (frontmatter + corpo) */
export function serializeSkill(skill: Pick<Skill, 'name' | 'description' | 'slug' | 'content'>): string {
  const lines = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `slug: ${skill.slug}`,
    '---',
    '',
    skill.content.trim(),
    '',
  ]
  return lines.join('\n')
}
