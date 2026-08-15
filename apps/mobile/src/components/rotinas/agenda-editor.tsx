import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  AlignLeft,
  Bot,
  BrainCircuit,
  Eye,
  FileText,
  Globe,
  Network,
  RefreshCw,
  Search,
} from 'lucide-react-native'
import type { Agenda, PermissionMode, RotinaModos } from '@orbit/shared'
import { parseHorario, ROTINA_MODOS, ROTINA_PERMISSAO_PADRAO, ROTINA_PERMISSOES } from '@orbit/shared'
import { Switch } from '~/components/ui/switch'
import { getThemeTokens, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { descreverAgenda, diasCurtos, modoDaAgenda, type ModoAgenda } from '~/lib/agenda'

/**
 * Edição da agenda e dos modos — compartilhada pela criação e pela edição de
 * uma rotina existente. Espelho do agenda-editor.tsx do desktop: presets +
 * ajuste fino, sem cron.
 */

const UTEIS = [1, 2, 3, 4, 5]
const FIM_DE_SEMANA = [0, 6]

/** Fundo do primary com alpha (ex.: primary a 10% — como bg-primary/10). */
function primaryBg(tokens: ThemeTokens, alpha: number): string {
  return hslToRgba(tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), alpha)
}

export function AgendaEditor({ agenda, onChange }: { agenda: Agenda; onChange: (agenda: Agenda) => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const modo = modoDaAgenda(agenda)
  const nomes = diasCurtos(t)
  const horarioValido = !!parseHorario(agenda.horario)

  const trocarModo = (proximo: ModoAgenda) => {
    if (proximo === 'diario') onChange({ horario: agenda.horario })
    else if (proximo === 'semanal') onChange({ horario: agenda.horario, dias: agenda.dias?.length ? agenda.dias : UTEIS })
    else onChange({ horario: agenda.horario, intervaloDias: agenda.intervaloDias ?? 2 })
  }

  const alternarDia = (dia: number) => {
    const atuais = new Set(agenda.dias ?? [])
    if (atuais.has(dia)) atuais.delete(dia)
    else atuais.add(dia)
    // Nunca deixa a lista vazia: sem nenhum dia marcado a rotina não teria
    // quando rodar, e a tela mostraria uma agenda que nunca dispara.
    const dias = [...atuais].sort((a, b) => a - b)
    onChange({ horario: agenda.horario, dias: dias.length ? dias : [dia] })
  }

  const chipAtivo = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  const chipInativo = { borderColor: 'transparent', backgroundColor: tokens.muted }

  return (
    <View style={{ gap: 10 }}>
      <View style={s.rowWrap}>
        {(['diario', 'semanal', 'intervalo'] as ModoAgenda[]).map((op) => (
          <Pressable
            key={op}
            onPress={() => trocarModo(op)}
            style={[s.chip, modo === op ? chipAtivo : chipInativo]}
          >
            <Text style={[s.chipText, { color: modo === op ? tokens.primary : tokens.mutedForeground }]}>
              {t(`rotinas.agenda.modo.${op}`)}
            </Text>
          </Pressable>
        ))}
        <View style={[s.horarioBox, { borderColor: horarioValido ? tokens.border : tokens.destructive }]}>
          <Text style={[s.horarioLabel, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.horario')}</Text>
          <TextInput
            value={agenda.horario}
            onChangeText={(horario) => onChange({ ...agenda, horario })}
            placeholder="HH:MM"
            placeholderTextColor={tokens.mutedForeground}
            style={[s.horarioInput, { color: tokens.foreground }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {modo === 'semanal' && (
        <View style={s.rowWrap}>
          {nomes.map((nome, dia) => {
            const ativo = agenda.dias?.includes(dia) ?? false
            return (
              <Pressable
                key={dia}
                onPress={() => alternarDia(dia)}
                style={[s.dayChip, ativo ? chipAtivo : chipInativo]}
              >
                <Text style={[s.dayChipText, { color: ativo ? tokens.primary : tokens.mutedForeground }]}>{nome}</Text>
              </Pressable>
            )
          })}
          <Pressable onPress={() => onChange({ horario: agenda.horario, dias: UTEIS })} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.uteis')}</Text>
          </Pressable>
          <Pressable onPress={() => onChange({ horario: agenda.horario, dias: FIM_DE_SEMANA })} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.fimDeSemana')}</Text>
          </Pressable>
        </View>
      )}

      {modo === 'intervalo' && (
        <View style={s.rowWrap}>
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.aCada')}</Text>
          <TextInput
            value={String(agenda.intervaloDias ?? 2)}
            onChangeText={(v) =>
              onChange({
                horario: agenda.horario,
                intervaloDias: Math.max(2, Math.min(365, Number(v) || 2)),
              })
            }
            keyboardType="number-pad"
            style={[s.intervaloInput, { borderColor: tokens.border, color: tokens.foreground }]}
          />
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.dias')}</Text>
        </View>
      )}

      <Text style={[s.resumo, { color: tokens.mutedForeground }]}>{descreverAgenda(agenda, t)}</Text>
    </View>
  )
}

// ─── Modos ───────────────────────────────────────────────────────────────────

/** Ícone de cada modo — os mesmos da seção "modos ativos" das preferências. */
const MODO_ICONE: Record<(typeof ROTINA_MODOS)[number], typeof Bot> = {
  brain: BrainCircuit,
  loop: RefreshCw,
  subagents: Bot,
  orchestrate: Network,
  browser: Globe,
  plan: FileText,
  simple: AlignLeft,
  search: Search,
  vision: Eye,
}

/** Chaves de modo editáveis — o subconjunto depende do modo da rotina. */
type ChaveDeModo = (typeof ROTINA_MODOS)[number]

/**
 * Modos como badges clicáveis, no mesmo padrão das preferências: ligado fica
 * na cor primary, desligado fica ghost. O agente SUGERE na criação — quem
 * confirma é o usuário, num clique.
 */
export function ModosEditor({
  modos,
  onChange,
  disponiveis = ROTINA_MODOS,
}: {
  modos: RotinaModos
  onChange: (modos: RotinaModos) => void
  /** Modos exibidos — rotina de chat recebe ROTINA_MODOS_CHAT. */
  disponiveis?: ChaveDeModo[]
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const permissao = modos.permissionMode ?? ROTINA_PERMISSAO_PADRAO

  const alternar = (chave: ChaveDeModo) => {
    const ligado = modos[chave] !== true
    const proximo: RotinaModos = { ...modos, [chave]: ligado || undefined }
    // Orquestração implica loop + subagentes e é incompatível com plano —
    // mesma regra do handler chat:send, aplicada aqui para a tela não mostrar
    // uma combinação que o backend vai desfazer sozinho.
    if (chave === 'orchestrate' && ligado) {
      proximo.loop = true
      proximo.subagents = true
      proximo.plan = undefined
    }
    if (chave === 'plan' && ligado) proximo.orchestrate = undefined
    onChange(proximo)
  }

  const chipAtivo = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  const chipInativo = { borderColor: 'transparent', backgroundColor: tokens.muted }

  return (
    <View style={{ gap: 10 }}>
      <View style={s.rowWrap}>
        {disponiveis.map((chave) => {
          const Icon = MODO_ICONE[chave]
          const ativo = modos[chave] === true
          return (
            <Pressable key={chave} onPress={() => alternar(chave)} style={[s.modoChip, ativo ? chipAtivo : chipInativo]}>
              <Icon size={13} color={ativo ? tokens.primary : tokens.mutedForeground} />
              <Text style={[s.chipText, { color: ativo ? tokens.primary : tokens.mutedForeground }]}>
                {t(`rotinas.modos.${chave}.nome`)}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={[s.secaoLabel, { color: tokens.mutedForeground }]}>{t('rotinas.modos.permissao')}</Text>
        <View style={s.rowWrap}>
          {ROTINA_PERMISSOES.map((op) => (
            <Pressable
              key={op}
              onPress={() => onChange({ ...modos, permissionMode: op })}
              style={[s.chip, permissao === op ? chipAtivo : chipInativo]}
            >
              <Text style={[s.chipText, { color: permissao === op ? tokens.primary : tokens.mutedForeground }]}>
                {t(`permissionModes.${op}`)}
              </Text>
            </Pressable>
          ))}
        </View>
        {permissao === 'ask' && (
          <Text style={[s.resumo, { color: tokens.mutedForeground }]}>{t('rotinas.modos.permissaoAviso')}</Text>
        )}
      </View>
    </View>
  )
}

/** Badges compactas (só leitura) dos modos ligados — cartão e detalhe. */
export function ModosBadges({
  modos,
  permissao,
  disponiveis = ROTINA_MODOS,
}: {
  modos: RotinaModos
  permissao?: boolean
  /** Modos considerados — rotina de chat não exibe loop/orquestra mesmo se o
   *  rotinas.json editado à mão tiver o campo (o scheduler ignora de todo). */
  disponiveis?: ChaveDeModo[]
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const ativos = disponiveis.filter((chave) => modos[chave] === true)
  const modoPermissao: PermissionMode = modos.permissionMode ?? ROTINA_PERMISSAO_PADRAO
  if (ativos.length === 0 && !permissao) return null
  const badgeStyle = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  return (
    <View style={s.rowWrap}>
      {ativos.map((chave) => {
        const Icon = MODO_ICONE[chave]
        return (
          <View key={chave} style={[s.badge, badgeStyle]}>
            <Icon size={11} color={tokens.primary} />
            <Text style={[s.badgeText, { color: tokens.primary }]}>{t(`rotinas.modos.${chave}.nome`)}</Text>
          </View>
        )
      })}
      {permissao && (
        <View style={[s.badge, { borderColor: 'transparent', backgroundColor: tokens.muted }]}>
          <Text style={[s.badgeText, { color: tokens.mutedForeground }]}>{t(`permissionModes.${modoPermissao}`)}</Text>
        </View>
      )}
    </View>
  )
}

/** Switch de ativar/desativar reusado pelo cartão e pelo header do detalhe. */
export function AtivaSwitch({ ativa, onChange }: { ativa: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Switch
      checked={ativa}
      onCheckedChange={onChange}
      accessibilityLabel={ativa ? t('rotinas.lista.ativa') : t('rotinas.lista.pausada')}
    />
  )
}

const s = StyleSheet.create({
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: { fontSize: 12, fontWeight: '500' },
  modoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  horarioBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  horarioLabel: { fontSize: 12 },
  horarioInput: { fontSize: 12, fontFamily: 'monospace', minWidth: 44, padding: 0 },
  dayChip: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayChipText: { fontSize: 12, fontWeight: '500' },
  linkText: { fontSize: 12 },
  intervaloInput: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 52,
    textAlign: 'center',
  },
  resumo: { fontSize: 12 },
  secaoLabel: { fontSize: 12, fontWeight: '500' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeText: { fontSize: 11, fontWeight: '500' },
})
