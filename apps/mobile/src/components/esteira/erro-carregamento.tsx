/**
 * Estado de erro de carregamento da esteira — substitui o spinner infinito
 * quando o fetch() falha (desktop desconectado, build antigo no servidor,
 * timeout...). Mostra o motivo técnico e um botão de retry.
 */
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { RefreshCw, TriangleAlert } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useEsteiraStore } from '~/stores/esteira-store'

/**
 * Renderiza o estado de erro quando `carregado` é false e `fetch` falhou.
 * Retorna `false` quando não há erro (para as telas usarem `if` simples).
 */
export function ErroCarregamento(): JSX.Element | false {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const erro = useEsteiraStore((s) => s.erro)
  const loading = useEsteiraStore((s) => s.loading)
  const fetch = useEsteiraStore((s) => s.fetch)

  if (!erro) return false

  return (
    <View style={s.box}>
      <TriangleAlert size={30} color={tokens.mutedForeground} style={{ opacity: 0.7 }} />
      <Text style={[s.titulo, { color: tokens.foreground }]}>{t('esteira.erroCarregarTitulo')}</Text>
      <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.erroCarregarDica')}</Text>
      <Text style={[s.motivo, { color: tokens.mutedForeground }]} numberOfLines={3}>
        {erro}
      </Text>
      <Pressable
        onPress={() => void fetch()}
        disabled={loading}
        style={[s.botao, { borderColor: tokens.border, opacity: loading ? 0.5 : 1 }]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={tokens.foreground} />
        ) : (
          <RefreshCw size={14} color={tokens.foreground} />
        )}
        <Text style={[s.botaoTexto, { color: tokens.foreground }]}>{t('esteira.tentarNovamente')}</Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  box: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 24,
  },
  titulo: { fontSize: 15, fontWeight: '600' },
  dica: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  motivo: { fontSize: 11, textAlign: 'center', opacity: 0.8 },
  botao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  botaoTexto: { fontSize: 13, fontWeight: '500' },
})
