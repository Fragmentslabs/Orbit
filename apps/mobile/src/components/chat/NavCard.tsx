import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Monitor } from 'lucide-react-native'
import { uiDestination } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Cartão de navegação — o espelho mobile do bloco `nav` do orbit-ui.
 *
 * O `destino` é um id do registro compartilhado (ui-destinations), e o rótulo
 * sai da chave de i18n que a própria tela usa, então renomear uma tela renomeia
 * o cartão. A tela que não existe no celular aparece explicada e inerte: um
 * botão que não abre nada é pior do que uma frase.
 *
 * Nada navega sozinho — o toque é o consentimento.
 */
export function NavCard({ destino, nota }: { destino: string; nota?: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const target = uiDestination(destino)

  // Id que o registro não conhece: silêncio, não um cartão vazio — a prosa da
  // mensagem já disse onde fica.
  if (!target) return null

  const screen = target.mobile

  if (!screen) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.muted }]}>
        <Monitor size={16} color={tokens.mutedForeground} />
        <Text style={[s.title, { color: tokens.mutedForeground }]}>{t('orbitUi.nav.otherSurface')}</Text>
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('orbitUi.nav.open')}: ${t(screen.titleKey)}`}
      onPress={() => router.push(screen.path as any)}
      style={({ pressed }) => [
        s.card,
        { borderColor: tokens.border, backgroundColor: tokens.card, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={[s.icon, { backgroundColor: withAlpha(tokens.primary, 0.14) }]}>
        <ArrowUpRight size={15} color={tokens.primary} />
      </View>
      <View style={s.body}>
        <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={1}>
          {t(screen.titleKey)}
        </Text>
        {nota ? (
          <Text style={[s.nota, { color: tokens.mutedForeground }]} numberOfLines={2}>
            {nota}
          </Text>
        ) : null}
      </View>
      <Text style={[s.action, { color: tokens.mutedForeground }]}>{t('orbitUi.nav.open')}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '600' },
  nota: { fontSize: 12, lineHeight: 16 },
  action: { fontSize: 12, fontWeight: '500' },
})
