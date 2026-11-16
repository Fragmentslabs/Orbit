import { useState } from 'react'
import { View, Text, TextInput, Pressable, Switch, ActivityIndicator, StyleSheet } from 'react-native'
import { CloudUpload } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { FolderCreateRemoteResponse } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useConnectionStore } from '~/stores/connection-store'
import { isValidRepoName, suggestRepoName } from '~/lib/init-project'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Creates the GitHub repository for a desktop folder that has commits and no remote — the
 * desktop's CreateRemoteRepoDialog. The token never reaches the phone: the desktop reads it from
 * its git credential helper or `gh`. Nothing is created until the person taps the button, and the
 * sheet says plainly what will happen (public/private, which folder).
 */
export function PublishRepoSheet({
  open,
  directory,
  onClose,
  onCreated,
}: {
  open: boolean
  directory: string
  onClose: () => void
  onCreated: (result: Extract<FolderCreateRemoteResponse, { ok: true }>) => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const wsClient = useConnectionStore((s) => s.wsClient)
  const [name, setName] = useState(() => suggestRepoName(directory))
  const [isPrivate, setIsPrivate] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset when the sheet opens (adjusting state during render, the official pattern).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(suggestRepoName(directory))
      setIsPrivate(true)
      setError(null)
      setCreating(false)
    }
  }

  const valid = isValidRepoName(name.trim())

  const create = async () => {
    if (!valid || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await wsClient.send({ type: 'folders:create-remote', directory, name: name.trim(), isPrivate })
      if (!res.ok || !res.data) {
        setError(res.error ?? t('publishRepo.errors.other'))
        return
      }
      const result = res.data as FolderCreateRemoteResponse
      if (result.ok) {
        onCreated(result)
        onClose()
        return
      }
      setError(
        result.kind === 'noCredential'
          ? t(result.hint === 'ghMissing' ? 'publishRepo.noCredentialMissing' : 'publishRepo.noCredentialOther')
          : result.kind === 'other'
            ? result.message
            : t(`publishRepo.errors.${result.kind}`),
      )
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} closeOnOutsideTap={!creating} title={t('publishRepo.title')}>
      <View style={s.body}>
        <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('publishRepo.description', { path: directory })}</Text>
        <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('publishRepo.name')}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!creating}
          style={[s.input, { borderColor: valid ? tokens.border : tokens.destructive, color: tokens.foreground }]}
        />
        {!valid && <Text style={[s.err, { color: tokens.destructive }]}>{t('publishRepo.errors.invalidName')}</Text>}
        <View style={s.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={[s.rowTitle, { color: tokens.foreground }]}>{isPrivate ? t('publishRepo.private') : t('publishRepo.public')}</Text>
            <Text style={[s.hint, { color: tokens.mutedForeground }]}>{isPrivate ? t('publishRepo.privateHint') : t('publishRepo.publicHint')}</Text>
          </View>
          <Switch value={isPrivate} onValueChange={setIsPrivate} disabled={creating} />
        </View>
        {error ? <Text style={[s.err, { color: tokens.destructive }]}>{error}</Text> : null}
        <Pressable
          onPress={() => void create()}
          disabled={!valid || creating}
          style={[s.cta, { backgroundColor: tokens.primary, opacity: !valid || creating ? 0.5 : 1 }]}
          accessibilityRole="button"
        >
          {creating ? <ActivityIndicator color={tokens.primaryForeground} /> : <CloudUpload size={16} color={tokens.primaryForeground} />}
          <Text style={[s.ctaText, { color: tokens.primaryForeground }]}>{t('publishRepo.create')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
  hint: { fontSize: 12.5, lineHeight: 17 },
  label: { fontSize: 11, letterSpacing: 1, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  err: { fontSize: 12.5 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 12, marginTop: 10 },
  ctaText: { fontSize: 15, fontWeight: '600' },
})
