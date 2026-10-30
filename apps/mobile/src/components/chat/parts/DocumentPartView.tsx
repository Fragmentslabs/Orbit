/**
 * Document authored by the agent (tool create_document / update_document).
 *
 * The preview is HTML (`previewSrc`) and opens in the same WebView host as the artifact —
 * the desktop generates the PDF FROM that HTML, so what is seen is what comes out
 * printed.
 *
 * The "original file": the part does NOT carry a URL for the .md nor for the PDF/DOCX — the
 * desktop only rewrites `previewSrc` and `thumb` (companion-media). So both
 * buttons act on the only URL that exists: open in the system browser (where
 * it can be saved/printed as PDF) and download/share the HTML. Building the URL
 * of the PDF here would be guessing the path of the desktop store — and phase 1 made it
 * clear that URL is not assembled on the phone.
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

/** Safe file name from the title — the share sheet uses the name. */
function fileNameFor(part: DocumentPart): string {
  const base = (part.title || part.documentId || 'document')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
  const safe = base || 'document'
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
      // Download instead of shareAsync(url): the native share sheet only accepts a
      // local file, and the document must arrive whole in the target app.
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
