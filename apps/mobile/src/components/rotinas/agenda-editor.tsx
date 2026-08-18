import { Component, useState, type ComponentType, type ReactNode } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, Modal, Platform } from 'react-native'
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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

// O pacote do datetimepicker chama TurboModuleRegistry.getEnforcing no load do
// módulo e LANÇA em binários sem o módulo nativo (build desatualizado / Expo
// Go antigo). Por isso o require é lazy e protegido: um import estático
// derrubaria a rota no carregamento (default export nunca registrado). Com o
// módulo ausente, a UI cai no seletor manual (SeletorHorarioManual).
const PickerNativo: ComponentType<any> | null = (() => {
  try {
    return require('@react-native-community/datetimepicker').default
  } catch {
    return null
  }
})()

/**
 * Edição da agenda e dos modos — compartilhada pela criação e pela edição de
 * uma rotina existente. Espelho do agenda-editor.tsx do desktop: presets +
 * ajuste fino, sem cron.
 */

const UTEIS = [1, 2, 3, 4, 5]
const FIM_DE_SEMANA = [0, 6]

/**
 * Modal centralizado de seleção de horário — estrutura compartilhada pelo
 * seletor nativo e pelo fallback manual: overlay escuro (tocar fora fecha
 * sem aplicar), view com fundo muted e cantos arredondados, controle no
 * centro e Cancelar/OK no rodapé do próprio modal.
 */
function TelaHorario({
  onCancelar,
  onOk,
  children,
}: {
  onCancelar: () => void
  onOk: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Modal visible animationType="fade" transparent onRequestClose={onCancelar}>
      <Pressable style={s.modalBackdrop} onPress={onCancelar} accessibilityLabel={t('scheduleSheet.cancel')}>
        <View style={[s.modalCaixa, { backgroundColor: tokens.muted }]}>
          <Text style={[s.modalTitulo, { color: tokens.foreground }]}>{t('rotinas.agenda.selecionarHorario')}</Text>
          <View style={s.modalConteudo}>{children}</View>
          <View style={[s.modalRodape, { borderTopColor: tokens.border }]}>
            <Pressable onPress={onCancelar} style={s.modalBotao} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16 }}>{t('scheduleSheet.cancel')}</Text>
            </Pressable>
            <View style={[s.modalDivisor, { backgroundColor: tokens.border }]} />
            <Pressable onPress={onOk} style={s.modalBotao} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16, fontWeight: '600' }}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

/**
 * Seletor de horário manual (fallback): grade de horas e minutos em tela
 * cheia, com o mesmo visual do seletor nativo. Só é usado quando o binário
 * não tem o módulo nativo do datetimepicker (build antigo / Expo Go) — o
 * caminho normal é o ModalSeletorHorario.
 */
function SeletorHorarioManual({
  valor,
  onSelecionar,
  onFechar,
}: {
  valor: string
  onSelecionar: (horario: string) => void
  onFechar: () => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const inicial = parseHorario(valor)
  const [hora, setHora] = useState(inicial?.hora ?? 9)
  const [minuto, setMinuto] = useState(inicial?.minuto ?? 0)
  const p = (n: number) => String(n).padStart(2, '0')
  const chip = (selecionado: boolean) => ({
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: selecionado ? tokens.primary : tokens.muted,
  })
  const chipText = (selecionado: boolean) => ({
    fontSize: 12,
    color: selecionado ? tokens.primaryForeground : tokens.mutedForeground,
  })
  return (
    <TelaHorario
      onCancelar={onFechar}
      onOk={() => {
        onSelecionar(`${p(hora)}:${p(minuto)}`)
        onFechar()
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: 28, fontWeight: '700', marginBottom: 16 }}>
        {p(hora)}:{p(minuto)}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <Pressable key={h} onPress={() => setHora(h)} style={chip(h === hora)}>
            <Text style={chipText(h === hora)}>{p(h)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280, marginTop: 8 }}>
        {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
          <Pressable key={m} onPress={() => setMinuto(m)} style={chip(m === minuto)}>
            <Text style={chipText(m === minuto)}>{p(m)}</Text>
          </Pressable>
        ))}
      </View>
    </TelaHorario>
  )
}

/** Fundo do primary com alpha (ex.: primary a 10% — como bg-primary/10). */
function primaryBg(tokens: ThemeTokens, alpha: number): string {
  return hslToRgba(tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), alpha)
}

/** Converte "HH:MM" em Date (hoje, no horário dado) para o picker nativo. */
function horarioParaDate(horario: string): Date {
  const p = parseHorario(horario)
  const d = new Date()
  d.setHours(p?.hora ?? 9, p?.minuto ?? 0, 0, 0)
  return d
}

function formatarData(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Seletor de horário nativo, aberto por um único toque no horário.
 * iOS: modal centralizado com o spinner nativo (as rodas do sistema) já
 * aberto — o controle compacto do sistema exigiria um segundo toque para
 * abrir o popover, então usamos o modal, que é o padrão do iOS para
 * horário. Android: dialog nativo. Requer o módulo nativo no binário.
 */
function ModalSeletorHorario({
  valor,
  onChange,
  onFechar,
}: {
  valor: string
  onChange: (horario: string) => void
  onFechar: () => void
}) {
  const tema = useThemeStore((s) => s.resolved)
  const [temporario, setTemporario] = useState(() => horarioParaDate(valor))

  // Sem o módulo nativo, o caller (AgendaEditor) nem chega a renderizar este
  // modal — cai no SeletorHorarioManual antes.
  if (!PickerNativo) return null

  if (Platform.OS === 'android') {
    return (
      <PickerNativo
        mode="time"
        value={temporario}
        is24Hour
        onChange={(evento: DateTimePickerEvent, data?: Date) => {
          if (evento.type === 'set' && data) onChange(formatarData(data))
          onFechar()
        }}
      />
    )
  }

  return (
    <TelaHorario
      onCancelar={onFechar}
      onOk={() => {
        onChange(formatarData(temporario))
        onFechar()
      }}
    >
      {/* O UIPickerView nativo tem altura fixa (216pt) mas pode desenhar o
          conteúdo deslocado dentro dela; o container flex centraliza as
          rodas verticalmente no espaço restante da tela. */}
      <PickerNativo
        mode="time"
        display="spinner"
        value={temporario}
        themeVariant={tema === 'dark' ? 'dark' : 'light'}
        onChange={(evento: DateTimePickerEvent, data?: Date) => {
          if (evento.type === 'set' && data) setTemporario(data)
        }}
      />
    </TelaHorario>
  )
}

/**
 * Boundary para builds sem o módulo nativo: se o datetimepicker lançar
 * (Native module cannot be null), cai no seletor manual em vez de derrubar a
 * tela. Depois de um erro, o manual passa a ser usado direto.
 */
class ErroNativoBoundary extends Component<{ fallback: ReactNode; onErro: () => void; children: ReactNode }, { erro: boolean }> {
  state = { erro: false }
  static getDerivedStateFromError() {
    return { erro: true }
  }
  componentDidCatch() {
    this.props.onErro()
  }
  render() {
    return this.state.erro ? this.props.fallback : this.props.children
  }
}

export function AgendaEditor({ agenda, onChange }: { agenda: Agenda; onChange: (agenda: Agenda) => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const modo = modoDaAgenda(agenda)
  const nomes = diasCurtos(t)
  const horarioValido = !!parseHorario(agenda.horario)
  const [mostrarPicker, setMostrarPicker] = useState(false)
  /** Binário sem o módulo nativo (build antigo) → usa o seletor manual. */
  const [modoNativo, setModoNativo] = useState(!!PickerNativo)
  const fecharPicker = () => setMostrarPicker(false)

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
        <Text style={[s.horarioLabel, { color: tokens.mutedForeground }]}>{t('rotinas.agenda.horario')}</Text>
        {mostrarPicker ? (
          modoNativo ? (
            <ErroNativoBoundary
              fallback={
                <SeletorHorarioManual
                  valor={agenda.horario}
                  onSelecionar={(horario) => {
                    onChange({ ...agenda, horario })
                    fecharPicker()
                  }}
                  onFechar={fecharPicker}
                />
              }
              onErro={() => setModoNativo(false)}
            >
              <ModalSeletorHorario
                valor={agenda.horario}
                onChange={(horario) => onChange({ ...agenda, horario })}
                onFechar={fecharPicker}
              />
            </ErroNativoBoundary>
          ) : (
            <SeletorHorarioManual
              valor={agenda.horario}
              onSelecionar={(horario) => {
                onChange({ ...agenda, horario })
                fecharPicker()
              }}
              onFechar={fecharPicker}
            />
          )
        ) : (
          <Pressable onPress={() => setMostrarPicker(true)} hitSlop={8}>
            <Text style={[s.horarioInput, { color: horarioValido ? tokens.foreground : tokens.destructive }]}>
              {agenda.horario}
            </Text>
          </Pressable>
        )}
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
                {t(`permissionModePicker.${op}`)}
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
          <Text style={[s.badgeText, { color: tokens.mutedForeground }]}>{t(`permissionModePicker.${modoPermissao}`)}</Text>
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
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  modalCaixa: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    paddingTop: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  modalTitulo: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  modalConteudo: { alignItems: 'center', paddingHorizontal: 20 },
  modalRodape: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  modalBotao: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  modalDivisor: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
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
  horarioLabel: { fontSize: 12 },
  horarioInput: { fontSize: 12, fontWeight: '500' },
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
