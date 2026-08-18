import { Component, useState, type ComponentType, type ReactNode } from 'react'
import { View, Text, Pressable, Modal, Platform, TextInput, StyleSheet } from 'react-native'
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { CalendarDays } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { CustomAnalyticsRange } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

// O pacote do datetimepicker chama TurboModuleRegistry.getEnforcing no load do
// módulo e LANÇA em binários sem o módulo nativo (build desatualizado / Expo
// Go antigo). Por isso o require é lazy e protegido: um import estático
// derrubaria esta rota no carregamento (default export nunca registrado). Com
// o módulo ausente, a UI cai no fallback manual (CampoDataManual).
const PickerNativo: ComponentType<any> | null = (() => {
  try {
    return require('@react-native-community/datetimepicker').default
  } catch {
    return null
  }
})()

/**
 * Seleção de período personalizado da tela de uso — espelho do date range
 * picker do desktop. iOS: calendário nativo inline dentro do modal; Android:
 * dialog nativo por campo (De/Até). Binários sem o módulo nativo caem no
 * fallback manual (campos DD/MM/AAAA).
 */

const DIA_MS = 24 * 60 * 60 * 1000

function comecoDoDia(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

function fimDoDia(d: Date): Date {
  const c = new Date(d)
  c.setHours(23, 59, 59, 999)
  return c
}

export function formatarDataCurta(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** "01 ago – 10 ago" — rótulo do chip quando o período customizado está ativo. */
export function rotuloPeriodo(range: CustomAnalyticsRange, locale: string): string {
  return `${formatarDataCurta(new Date(range.from), locale)} – ${formatarDataCurta(new Date(range.to), locale)}`
}

/** Fallback manual: só números DD/MM/AAAA, para builds sem o módulo nativo. */
function CampoDataManual({
  valor,
  locale,
  onChange,
}: {
  valor: Date
  locale: string
  onChange: (d: Date) => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const texto = valor.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
  return (
    <TextInput
      value={texto}
      keyboardType="numeric"
      onChangeText={(v) => {
        const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (!m) return
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
        if (!Number.isNaN(d.getTime())) onChange(d)
      }}
      style={[s.inputManual, { borderColor: tokens.border, color: tokens.foreground }]}
    />
  )
}

/** Boundary: se o datetimepicker lançar (módulo nativo ausente), usa o manual. */
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

export function CustomRangeModal({
  visivel,
  valorAtual,
  onCancelar,
  onConfirmar,
}: {
  visivel: boolean
  valorAtual: CustomAnalyticsRange | null
  onCancelar: () => void
  onConfirmar: (range: CustomAnalyticsRange) => void
}) {
  const { t, i18n } = useTranslation()
  const tema = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(tema)
  const [de, setDe] = useState(() => (valorAtual ? new Date(valorAtual.from) : new Date(Date.now() - 6 * DIA_MS)))
  const [ate, setAte] = useState(() => (valorAtual ? new Date(valorAtual.to) : new Date()))
  const [campo, setCampo] = useState<'de' | 'ate'>('de')
  const [campoAberto, setCampoAberto] = useState<'de' | 'ate' | null>(null)
  const [modoNativo, setModoNativo] = useState(!!PickerNativo)

  const valorDoCampo = campo === 'de' ? de : ate
  const definirValor = campo === 'de' ? setDe : setAte

  const confirmar = () => {
    let inicio = comecoDoDia(de)
    let fim = fimDoDia(ate)
    // Seleção invertida (até antes do de) — inverte, como no picker do desktop.
    if (fim.getTime() < inicio.getTime()) {
      const trocado = inicio
      inicio = comecoDoDia(ate)
      fim = fimDoDia(trocado)
    }
    onConfirmar({ type: 'custom', from: inicio.getTime(), to: fim.getTime() })
  }

  const chipEstilo = (ativo: boolean) => ({
    borderColor: ativo ? tokens.primary : tokens.border,
    backgroundColor: ativo ? tokens.background : tokens.muted,
  })

  const seletorNativo = PickerNativo ? (
    <PickerNativo
      mode="date"
      display={Platform.OS === 'ios' ? 'inline' : 'default'}
      value={valorDoCampo}
      maximumDate={new Date()}
      locale={i18n.language}
      themeVariant={tema === 'dark' ? 'dark' : 'light'}
      onChange={(evento: DateTimePickerEvent, data?: Date) => {
        if (Platform.OS === 'android') {
          setCampoAberto(null)
          if (evento.type === 'set' && data) definirValor(data)
        } else if (data) {
          definirValor(data)
        }
      }}
    />
  ) : null

  return (
    <Modal visible={visivel} animationType="fade" transparent onRequestClose={onCancelar}>
      <Pressable style={s.backdrop} onPress={onCancelar} accessibilityLabel={t('scheduleSheet.cancel')}>
        <View style={[s.caixa, { backgroundColor: tokens.card }]}>
          <Text style={[s.titulo, { color: tokens.foreground }]}>{t('usageScreen.rangeCustom')}</Text>

          <View style={s.camposRow}>
            {(['de', 'ate'] as const).map((c) => (
              <Pressable
                key={c}
                onPress={() => {
                  setCampo(c)
                  setCampoAberto(c)
                }}
                style={[s.campoChip, chipEstilo(campo === c)]}
              >
                <CalendarDays size={14} color={campo === c ? tokens.primary : tokens.mutedForeground} />
                <Text style={[s.campoLabel, { color: campo === c ? tokens.primary : tokens.mutedForeground }]}>
                  {t(c === 'de' ? 'usageScreen.customFrom' : 'usageScreen.customTo')}
                </Text>
                <Text style={[s.campoValor, { color: tokens.foreground }]}>
                  {formatarDataCurta(c === 'de' ? de : ate, i18n.language)}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={s.seletorWrap}>
            {Platform.OS === 'android' ? (
              campoAberto ? (
                <ErroNativoBoundary
                  fallback={<CampoDataManual valor={valorDoCampo} locale={i18n.language} onChange={definirValor} />}
                  onErro={() => setModoNativo(false)}
                >
                  {seletorNativo}
                </ErroNativoBoundary>
              ) : (
                <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('usageScreen.customHint')}</Text>
              )
            ) : modoNativo ? (
              <ErroNativoBoundary
                fallback={<CampoDataManual valor={valorDoCampo} locale={i18n.language} onChange={definirValor} />}
                onErro={() => setModoNativo(false)}
              >
                {seletorNativo}
              </ErroNativoBoundary>
            ) : (
              <CampoDataManual valor={valorDoCampo} locale={i18n.language} onChange={definirValor} />
            )}
          </View>

          <View style={[s.rodape, { borderTopColor: tokens.border }]}>
            <Pressable onPress={onCancelar} style={s.botao} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16 }}>{t('scheduleSheet.cancel')}</Text>
            </Pressable>
            <View style={[s.divisor, { backgroundColor: tokens.border }]} />
            <Pressable onPress={confirmar} style={s.botao} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16, fontWeight: '600' }}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  caixa: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    paddingTop: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  titulo: { fontSize: 16, fontWeight: '600', marginBottom: 14 },
  camposRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, width: '100%' },
  campoChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  campoLabel: { fontSize: 12, fontWeight: '600' },
  campoValor: { fontSize: 12, marginLeft: 'auto' },
  seletorWrap: { alignItems: 'center', paddingHorizontal: 16, marginTop: 8, minHeight: 60 },
  dica: { fontSize: 12, paddingVertical: 20 },
  inputManual: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'monospace',
    minWidth: 140,
    textAlign: 'center',
    marginTop: 8,
  },
  rodape: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    alignSelf: 'stretch',
  },
  botao: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  divisor: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
})
