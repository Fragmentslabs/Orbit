/**
 * Troca de branch da pasta de trabalho, a partir do menu do header do chat.
 * Porte reduzido do BranchSelector do desktop: lista as branches locais,
 * marca a atual e faz checkout. Criar branch, commitar e pull/push ficaram de
 * fora — no celular o caso real é "estou na branch errada", não gerir o repo.
 */
import { useCallback, useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GitBranch, Check, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { BranchesResponse } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function BranchSheet({
  visible,
  directory,
  onClose,
}: {
  visible: boolean
  directory?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const wsClient = useConnectionStore((s) => s.wsClient)
  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!directory) return
    setLoading(true)
    setError(null)
    try {
      const res = await wsClient.send({ type: 'git:branches', directory })
      if (res.ok && res.data) {
        const data = res.data as BranchesResponse
        setBranches(data.branches)
        setCurrent(data.current)
      } else {
        setError(res.error ?? t('branch.loadError'))
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [wsClient, directory, t])

  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  const checkout = async (branch: string) => {
    if (!directory || branch === current) return
    setSwitching(branch)
    setError(null)
    const res = await wsClient.send({ type: 'git:checkout', directory, branch })
    setSwitching(null)
    if (res.ok) {
      setCurrent(branch)
      onClose()
      return
    }
    // Árvore suja: o git recusa e a mensagem dele é o que aparece — não
    // forçamos checkout por cima de alterações não commitadas.
    setError(res.error ?? t('branch.switchError'))
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 12, backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.header}>
            <Text style={[s.title, { color: tokens.foreground }]}>{t('branch.title')}</Text>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          {error && <Text style={[s.error, { color: tokens.destructive }]}>{error}</Text>}

          {loading ? (
            <View style={{ paddingVertical: 32, alignItems: 'center' }}>
              <ActivityIndicator color={tokens.primary} />
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 320 }}>
              {branches.map((branch) => (
                <Pressable key={branch} onPress={() => void checkout(branch)} style={s.row}>
                  <GitBranch size={16} color={tokens.mutedForeground} />
                  <Text style={[s.name, { color: tokens.foreground }]} numberOfLines={1}>
                    {branch}
                  </Text>
                  {switching === branch ? (
                    <ActivityIndicator size="small" color={tokens.primary} />
                  ) : (
                    branch === current && <Check size={16} color={tokens.primary} />
                  )}
                </Pressable>
              ))}
              {branches.length === 0 && !error && (
                <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('branch.none')}</Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 12, borderRadius: 10 },
  name: { flex: 1, fontSize: 14 },
  error: { fontSize: 12, paddingHorizontal: 4, paddingBottom: 8 },
  empty: { fontSize: 13, padding: 16 },
})
