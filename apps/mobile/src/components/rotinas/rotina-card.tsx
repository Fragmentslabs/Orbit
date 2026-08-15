import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Loader2 } from 'lucide-react-native'
import type { Rotina } from '@orbit/shared'
import { proximaExecucaoDaRotina, ROTINA_MODOS_CHAT } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useRotinasStore } from '~/stores/rotinas-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { descreverAgenda } from '~/lib/agenda'
import { formatDateTimeShort } from '~/lib/format-time'
import { Spin } from '~/components/ui/spin'
import { ModosBadges, AtivaSwitch } from './agenda-editor'

/** Cartão de UMA rotina na listagem — espelho do CartaoDaRotina do desktop. */
export function RotinaCard({ rotina, onAbrir }: { rotina: Rotina; onAbrir: () => void }) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const atualizar = useRotinasStore((s) => s.atualizar)
  const rodando = useRotinasStore((s) => s.runs.some((r) => r.rotinaId === rotina.id && r.status === 'rodando'))
  const catalog = useSettingsStore((s) => s.catalog)
  const nomeModelo = catalog?.[rotina.modelo.providerId]?.models[rotina.modelo.modelId]?.name ?? rotina.modelo.modelId

  const proxima = proximaExecucaoDaRotina(rotina)

  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.linhaTitulo}>
        <CalendarClock size={16} color={tokens.mutedForeground} />
        <Pressable onPress={onAbrir} style={{ minWidth: 0, flex: 1 }}>
          <Text numberOfLines={1} style={[s.titulo, { color: tokens.foreground }]}>
            {rotina.titulo}
          </Text>
        </Pressable>
        {rodando && (
          <Spin>
            <Loader2 size={14} color={tokens.primary} />
          </Spin>
        )}
        <AtivaSwitch ativa={rotina.ativa} onChange={(v) => void atualizar(rotina.id, { ativa: v })} />
      </View>

      <Pressable onPress={onAbrir} style={{ gap: 6 }}>
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {descreverAgenda(rotina.agenda, t)}
        </Text>
        <Text numberOfLines={2} style={[s.prompt, { color: tokens.mutedForeground }]}>
          {rotina.prompt}
        </Text>
        <ModosBadges modos={rotina.modos} permissao disponiveis={rotina.mode === 'chat' ? ROTINA_MODOS_CHAT : undefined} />
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {nomeModelo}
        </Text>
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {proxima
            ? t('rotinas.lista.proxima', { quando: formatDateTimeShort(proxima, i18n.language) })
            : t('rotinas.lista.pausada')}
        </Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  linhaTitulo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { fontSize: 15, fontWeight: '500' },
  muted: { fontSize: 12 },
  prompt: { fontSize: 12, lineHeight: 16, opacity: 0.8 },
})
