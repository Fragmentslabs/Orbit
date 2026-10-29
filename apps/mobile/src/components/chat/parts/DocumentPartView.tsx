/**
 * Documento autorado pelo agente (tool create_document / update_document).
 *
 * O preview é HTML (`previewSrc`) e abre no mesmo host de WebView do artefato —
 * o desktop gera o PDF A PARTIR desse HTML, então o que se vê é o que sai
 * impresso.
 *
 * O "arquivo original": a part NÃO carrega URL do .md nem do PDF/DOCX — o
 * desktop só reescreve `previewSrc` e `thumb` (companion-media). Então os dois
 * botões agem sobre a única URL que existe: abrir no navegador do sistema (onde
 * dá para salvar/imprimir em PDF) e baixar/compartilhar o HTML. Construir a URL
 * do PDF aqui seria adivinhar o caminho do store do desktop — e a fase 1 deixou
 * claro que URL não se monta no celular.
 */
import { useCallback, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as Sharing from 'expo-sharing'
import * as FileSystem from 'expo-file-system/legacy'
import { Download, ExternalLink } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { DocumentPart } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { PieceView } from '../PieceView'

/** Nome de arquivo seguro a partir do título — o share sheet usa o nome. */
function fileNameFor(part: DocumentPart): string {
  const base = (part.title || part.documentId || 'documento')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
  const safe = base || 'documento'
  return safe.toLowerCase().endsWith('.html') ? safe : `${safe}.html`
}

export function DocumentPartView({ part }: { part: DocumentPart }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [busy, setBusy] = useState<'open' | 'share' | null>(null)
  const [error, setError] = useState(false)

  const open = useCallback(async () => {
    if (!part.previewSrc) return
    setError(false)
    setBusy('open')
    try {
      if (Platform.OS === 'web') {
        window.open(part.previewSrc, '_blank')
      } else {
        await WebBrowser.openBrowserAsync(part.previewSrc)
      }
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }, [part.previewSrc])

  const share = useCallback(async () => {
    if (!part.previewSrc) return
    setError(false)
    setBusy('share')
    try {
      if (Platform.OS === 'web') {
        window.open(part.previewSrc, '_blank')
        return
      }
      const dir = FileSystem.cacheDirectory
      if (!dir) throw new Error('sem cache')
      const target = `${dir}${fileNameFor(part)}`
      // Download em vez de shareAsync(url): o share sheet nativo só aceita
      // arquivo local, e o documento precisa chegar inteiro no app de destino.
      const downloaded = await FileSystem.downloadAsync(part.previewSrc, target)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri, {
          mimeType: 'text/html',
          dialogTitle: part.title || t('parts.document.title'),
        })
      }
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }, [part, t])

  const footer = (
    <View
      className="flex-row items-center gap-2 px-3 py-2"
      style={{ borderTopWidth: 1, borderTopColor: tokens.border }}
    >
      <Pressable
        onPress={open}
        disabled={busy !== null || !part.previewSrc}
        accessibilityRole="button"
        accessibilityLabel={t('parts.document.openLabel')}
        className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5"
        style={{ backgroundColor: tokens.muted, opacity: busy && busy !== 'open' ? 0.5 : 1 }}
      >
        {busy === 'open' ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }] }} color={tokens.primary} />
        ) : (
          <ExternalLink size={13} color={tokens.primary} />
        )}
        <Text className="text-xs font-medium" style={{ color: tokens.foreground }}>
          {t('parts.document.open')}
        </Text>
      </Pressable>

      <Pressable
        onPress={share}
        disabled={busy !== null || !part.previewSrc}
        accessibilityRole="button"
        accessibilityLabel={t('parts.document.downloadLabel')}
        className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5"
        style={{ backgroundColor: tokens.muted, opacity: busy && busy !== 'share' ? 0.5 : 1 }}
      >
        {busy === 'share' ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }] }} color={tokens.primary} />
        ) : (
          <Download size={13} color={tokens.primary} />
        )}
        <Text className="text-xs font-medium" style={{ color: tokens.foreground }}>
          {t('parts.document.download')}
        </Text>
      </Pressable>

      {error ? (
        <Text numberOfLines={2} className="flex-1 text-[10px]" style={{ color: tokens.destructive }}>
          {t('parts.document.actionFailed')}
        </Text>
      ) : null}
    </View>
  )

  return (
    <PieceView
      src={part.previewSrc}
      title={part.title}
      poster={part.thumb}
      revision={part.revision}
      height={360}
      footer={footer}
      emptyLabel={t('parts.document.empty')}
      loadingLabel={t('parts.document.loading')}
      errorLabel={t('parts.document.error')}
    />
  )
}
