import { useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, Switch, StyleSheet, Alert } from 'react-native'
import { X, Save, Plus, Trash2 } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { McpServerConfig, McpConfig } from '@orbit/shared'

interface McpServerFormModalProps {
  visible: boolean
  onClose: () => void
  edit?: McpServerConfig
}

function usePermissionModes() {
  const { t } = useTranslation()
  return [
    { id: 'ask' as const, label: t('mcpServerFormModal.permissionModes.ask') },
    { id: 'approve' as const, label: t('mcpServerFormModal.permissionModes.approve') },
    { id: 'full' as const, label: t('mcpServerFormModal.permissionModes.full') },
  ]
}

export function McpServerFormModal({ visible, onClose, edit }: McpServerFormModalProps) {
  const { t } = useTranslation()
  const PERMISSION_MODES = usePermissionModes()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const saveMcpConfig = useToolsStore((s) => s.saveMcpConfig)
  const mcpServers = useToolsStore((s) => s.mcpServers)

  const [name, setName] = useState(edit?.name ?? '')
  const [type, setType] = useState<'http' | 'stdio'>(edit?.type ?? 'http')
  const [url, setUrl] = useState(edit?.url ?? '')
  const [command, setCommand] = useState(edit?.command ?? '')
  const [argsText, setArgsText] = useState(edit?.args?.join('\n') ?? '')
  const [cwd, setCwd] = useState(edit?.cwd ?? '')
  const [permissionMode, setPermissionMode] = useState<'ask' | 'approve' | 'full'>(edit?.permissionMode ?? 'ask')
  const [autoReconnect, setAutoReconnect] = useState(edit?.autoReconnect ?? true)
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>(
    edit?.headers ? Object.entries(edit.headers).map(([k, v]) => ({ key: k, value: v })) : [],
  )
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    edit?.env ? Object.entries(edit.env).map(([k, v]) => ({ key: k, value: v })) : [],
  )
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return Alert.alert(t('mcpServerFormModal.nameRequiredTitle'), t('mcpServerFormModal.nameRequiredBody'))

    const config: McpServerConfig = {
      name: name.trim(),
      type,
      enabled: true,
      autoReconnect,
      permissionMode,
    }

    if (type === 'http') {
      if (!url.trim()) return Alert.alert(t('mcpServerFormModal.urlRequiredTitle'), t('mcpServerFormModal.urlRequiredBody'))
      config.url = url.trim()
      const hdrs = headers.filter((h) => h.key.trim())
      if (hdrs.length > 0) {
        config.headers = Object.fromEntries(hdrs.map((h) => [h.key.trim(), h.value]))
      }
      // As credenciais OAuth só são editáveis no desktop (é lá que o fluxo
      // roda); salvar daqui não pode descartá-las.
      if (edit?.oauth) config.oauth = edit.oauth
    } else {
      if (!command.trim()) return Alert.alert(t('mcpServerFormModal.commandRequiredTitle'), t('mcpServerFormModal.commandRequiredBody'))
      config.command = command.trim()
      const args = argsText.split('\n').map((a) => a.trim()).filter(Boolean)
      if (args.length > 0) config.args = args
      if (cwd.trim()) config.cwd = cwd.trim()
      const env = envVars.filter((e) => e.key.trim())
      if (env.length > 0) {
        config.env = Object.fromEntries(env.map((e) => [e.key.trim(), e.value]))
      }
    }

    setSaving(true)
    try {
      const existing = mcpServers.map((s) => s.config)
      const filtered = edit ? existing.filter((s) => s.name !== edit.name) : existing
      const fullConfig: McpConfig = { servers: [...filtered, config] }
      await saveMcpConfig(fullConfig)
      onClose()
    } catch {
      Alert.alert(t('mcpServerFormModal.errorTitle'), t('mcpServerFormModal.errorBody'))
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    setName(edit?.name ?? '')
    setType(edit?.type ?? 'http')
    setUrl(edit?.url ?? '')
    setCommand(edit?.command ?? '')
    setArgsText(edit?.args?.join('\n') ?? '')
    setCwd(edit?.cwd ?? '')
    setPermissionMode(edit?.permissionMode ?? 'ask')
    setAutoReconnect(edit?.autoReconnect ?? true)
    setHeaders(edit?.headers ? Object.entries(edit.headers).map(([k, v]) => ({ key: k, value: v })) : [])
    setEnvVars(edit?.env ? Object.entries(edit.env).map(([k, v]) => ({ key: k, value: v })) : [])
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>
              {edit ? t('mcpServerFormModal.editTitle') : t('mcpServerFormModal.newTitle')}
            </Text>
            <Pressable onPress={handleClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingBottom: 24 }}>
            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.nameLabel')}</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t('mcpServerFormModal.namePlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
              />
            </View>

            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.typeLabel')}</Text>
              <View style={s.segmented}>
                <Pressable
                  onPress={() => setType('http')}
                  style={[s.segment, type === 'http' && { backgroundColor: tokens.primary }, { borderColor: tokens.border }]}
                >
                  <Text style={[s.segmentText, { color: type === 'http' ? '#fff' : tokens.foreground }]}>HTTP</Text>
                </Pressable>
                <Pressable
                  onPress={() => setType('stdio')}
                  style={[s.segment, type === 'stdio' && { backgroundColor: tokens.primary }, { borderColor: tokens.border }]}
                >
                  <Text style={[s.segmentText, { color: type === 'stdio' ? '#fff' : tokens.foreground }]}>STDIO</Text>
                </Pressable>
              </View>
            </View>

            {type === 'http' ? (
              <View>
                <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.urlLabel')}</Text>
                <TextInput
                  value={url}
                  onChangeText={setUrl}
                  placeholder="http://localhost:3000/mcp"
                  placeholderTextColor={tokens.mutedForeground}
                  autoCapitalize="none"
                  keyboardType="url"
                  style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                />
                <Text style={[s.fieldHint, { color: tokens.mutedForeground }]}>
                  {t('mcpServerFormModal.urlHint')}
                </Text>

                <Text style={[s.label, { color: tokens.mutedForeground, marginTop: 8 }]}>{t('mcpServerFormModal.httpHeaders')}</Text>
                {headers.map((h, i) => (
                  <View key={i} style={s.kvRow}>
                    <TextInput
                      value={h.key}
                      onChangeText={(v) => {
                        const next = [...headers]; next[i] = { ...next[i], key: v }; setHeaders(next)
                      }}
                      placeholder={t('mcpServerFormModal.keyPlaceholder')}
                      placeholderTextColor={tokens.mutedForeground}
                      style={[s.kvKey, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                    />
                    <TextInput
                      value={h.value}
                      onChangeText={(v) => {
                        const next = [...headers]; next[i] = { ...next[i], value: v }; setHeaders(next)
                      }}
                      placeholder={t('mcpServerFormModal.valuePlaceholder')}
                      placeholderTextColor={tokens.mutedForeground}
                      style={[s.kvValue, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                    />
                    <Pressable onPress={() => setHeaders(headers.filter((_, j) => j !== i))} style={s.kvRemove}>
                      <Trash2 size={14} color={tokens.destructive} />
                    </Pressable>
                  </View>
                ))}
                <Pressable onPress={() => setHeaders([...headers, { key: '', value: '' }])} style={s.addBtn}>
                  <Plus size={14} color={tokens.primary} />
                  <Text style={[s.addText, { color: tokens.primary }]}>{t('mcpServerFormModal.addHeader')}</Text>
                </Pressable>
              </View>
            ) : (
              <View>
                <View>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.command')}</Text>
                  <TextInput
                    value={command}
                    onChangeText={setCommand}
                    placeholder="npx"
                    placeholderTextColor={tokens.mutedForeground}
                    autoCapitalize="none"
                    style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                  />
                </View>

                <View style={{ marginTop: 10 }}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.argsLabel')}</Text>
                  <TextInput
                    value={argsText}
                    onChangeText={setArgsText}
                    placeholder="--args"
                    placeholderTextColor={tokens.mutedForeground}
                    multiline
                    autoCapitalize="none"
                    style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border, minHeight: 60 }]}
                  />
                </View>

                <View style={{ marginTop: 10 }}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.cwdLabel')}</Text>
                  <TextInput
                    value={cwd}
                    onChangeText={setCwd}
                    placeholder={t('mcpServerFormModal.cwdPlaceholder')}
                    placeholderTextColor={tokens.mutedForeground}
                    autoCapitalize="none"
                    style={[s.input, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                  />
                </View>

                <View style={{ marginTop: 10 }}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.envVars')}</Text>
                  {envVars.map((e, i) => (
                    <View key={i} style={s.kvRow}>
                      <TextInput
                        value={e.key}
                        onChangeText={(v) => {
                          const next = [...envVars]; next[i] = { ...next[i], key: v }; setEnvVars(next)
                        }}
                        placeholder={t('mcpServerFormModal.keyPlaceholder')}
                        placeholderTextColor={tokens.mutedForeground}
                        style={[s.kvKey, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                      />
                      <TextInput
                        value={e.value}
                        onChangeText={(v) => {
                          const next = [...envVars]; next[i] = { ...next[i], value: v }; setEnvVars(next)
                        }}
                        placeholder={t('mcpServerFormModal.valuePlaceholder')}
                        placeholderTextColor={tokens.mutedForeground}
                        style={[s.kvValue, { color: tokens.foreground, backgroundColor: tokens.card, borderColor: tokens.border }]}
                      />
                      <Pressable onPress={() => setEnvVars(envVars.filter((_, j) => j !== i))} style={s.kvRemove}>
                        <Trash2 size={14} color={tokens.destructive} />
                      </Pressable>
                    </View>
                  ))}
                  <Pressable onPress={() => setEnvVars([...envVars, { key: '', value: '' }])} style={s.addBtn}>
                    <Plus size={14} color={tokens.primary} />
                    <Text style={[s.addText, { color: tokens.primary }]}>{t('mcpServerFormModal.addVar')}</Text>
                  </Pressable>
                </View>
              </View>
            )}

            <View>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('mcpServerFormModal.permissionMode')}</Text>
              <View style={s.permissionRow}>
                {PERMISSION_MODES.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => setPermissionMode(m.id)}
                    style={[
                      s.permissionChip,
                      permissionMode === m.id
                        ? { backgroundColor: tokens.primary }
                        : { backgroundColor: tokens.muted, borderColor: tokens.border },
                    ]}
                  >
                    <Text
                      style={[
                        s.permissionText,
                        { color: permissionMode === m.id ? '#fff' : tokens.foreground },
                      ]}
                    >
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={s.switchRow}>
              <Text style={[s.switchLabel, { color: tokens.foreground }]}>{t('mcpServerFormModal.autoReconnect')}</Text>
              <Switch
                value={autoReconnect}
                onValueChange={setAutoReconnect}
                trackColor={{ false: tokens.muted, true: tokens.primary }}
                thumbColor={tokens.foreground}
              />
            </View>
          </ScrollView>

          <View style={[s.footer, { borderTopColor: tokens.border }]}>
            <Pressable onPress={handleClose} style={[s.cancelBtn, { borderColor: tokens.border }]}>
              <Text style={[s.cancelText, { color: tokens.foreground }]}>{t('mcpServerFormModal.cancel')}</Text>
            </Pressable>
            <Pressable onPress={handleSave} disabled={saving} style={[s.saveBtn, { backgroundColor: tokens.primary, opacity: saving ? 0.6 : 1 }]}>
              <Save size={16} color="#fff" />
              <Text style={s.saveText}>{saving ? t('mcpServerFormModal.saving') : t('mcpServerFormModal.save')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '90%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  closeBtn: { padding: 4, borderRadius: 8 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  fieldHint: { fontSize: 11, marginTop: 4 },
  segmented: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  segmentText: { fontSize: 13, fontWeight: '600' },
  kvRow: { flexDirection: 'row', gap: 6, marginBottom: 6, alignItems: 'center' },
  kvKey: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  kvValue: { flex: 1.5, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  kvRemove: { padding: 6 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  addText: { fontSize: 12, fontWeight: '600' },
  permissionRow: { flexDirection: 'row', gap: 8 },
  permissionChip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  permissionText: { fontSize: 12, fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchLabel: { fontSize: 14, fontWeight: '500' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: { fontSize: 14, fontWeight: '600' },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    paddingVertical: 12,
  },
  saveText: { fontSize: 14, fontWeight: '600', color: '#fff' },
})
