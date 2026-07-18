/**
 * Card de memória — espelho do memory-card do desktop: texto, badges por
 * kind/categoria/projeto, tags, barra de peso, usos/data, conectadas e ações
 * (doc, promover, editar, excluir). No mobile as ações ficam sempre visíveis
 * (não há hover).
 */
import { useEffect, useState } from 'react'
import { View, Text, Pressable, TextInput, Modal, ScrollView, Alert, StyleSheet } from 'react-native'
import { ArrowUpCircle, FileText, Link2, Pencil, Trash2, X } from 'lucide-react-native'
import type { Memory } from '@orbit/shared'
import { useMemoryStore } from '~/stores/memory-store'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { KIND_COLOR, KIND_LABEL, CATEGORY_LABEL, canPromote, formatDate } from './meta'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const WEIGHT_PRESETS = [0.2, 0.4, 0.6, 0.8, 1]

function EditModal({ memory, visible, onClose }: {
  memory: Memory
  visible: boolean
  onClose: () => void
}) {
  const update = useMemoryStore((s) => s.update)
  const [text, setText] = useState(memory.text)
  const [tags, setTags] = useState(memory.tags.join(', '))
  const [weight, setWeight] = useState(memory.weight)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  useEffect(() => {
    if (visible) {
      setText(memory.text)
      setTags(memory.tags.join(', '))
      setWeight(memory.weight)
    }
  }, [visible, memory])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={[s.modalBox, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <Text style={[s.modalTitle, { color: tokens.foreground }]}>Editar memória</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            style={[s.modalInput, { minHeight: 80, textAlignVertical: 'top', borderColor: tokens.border, color: tokens.foreground }]}
            placeholderTextColor={tokens.mutedForeground}
          />
          <TextInput
            value={tags}
            onChangeText={setTags}
            placeholder="tags separadas por vírgula"
            placeholderTextColor={tokens.mutedForeground}
            style={[s.modalInput, { borderColor: tokens.border, color: tokens.foreground }]}
            autoCapitalize="none"
          />
          <View style={s.weightRow}>
            <Text style={[s.weightLabel, { color: tokens.mutedForeground }]}>Peso</Text>
            <View style={s.weightChips}>
              {WEIGHT_PRESETS.map((preset) => (
                <Pressable
                  key={preset}
                  onPress={() => setWeight(preset)}
                  style={[s.weightChip, { borderColor: tokens.muted }, Math.abs(weight - preset) < 0.11 && { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
                >
                  <Text
                    style={[
                      { fontSize: 12, color: tokens.mutedForeground },
                      Math.abs(weight - preset) < 0.11 && { color: tokens.primaryForeground, fontWeight: '600' },
                    ]}
                  >
                    {preset.toFixed(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={s.modalActions}>
            <Pressable onPress={onClose} style={s.cancelBtn}>
              <Text style={[s.cancelText, { color: tokens.mutedForeground }]}>Cancelar</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!text.trim()) return
                void update(memory.id, {
                  text: text.trim(),
                  tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
                  weight,
                })
                onClose()
              }}
              style={[s.saveBtn, { backgroundColor: tokens.primary }]}
            >
              <Text style={[s.saveText, { color: tokens.primaryForeground }]}>Salvar</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function DocModal({ memory, visible, onClose }: {
  memory: Memory
  visible: boolean
  onClose: () => void
}) {
  const openDoc = useMemoryStore((s) => s.openDoc)
  const [doc, setDoc] = useState<string | null>(null)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  useEffect(() => {
    if (visible) {
      setDoc(null)
      void openDoc(memory.id).then(setDoc)
    }
  }, [visible, memory.id, openDoc])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.docBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.docSheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={s.docHandle} />
          <View style={s.docHeader}>
            <Text style={[s.docTitle, { color: tokens.foreground }]} numberOfLines={2}>{memory.text}</Text>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
            {doc === null ? (
              <Text style={[s.docLoading, { color: tokens.mutedForeground }]}>Carregando documento…</Text>
            ) : (
              <AssistantMarkdown text={doc} />
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

export function MemoryCard({ memory, related, onSelectRelated }: {
  memory: Memory
  /** Memórias em relatedIds já resolvidas pelo pai */
  related: Memory[]
  onSelectRelated?: (id: string) => void
}) {
  const remove = useMemoryStore((s) => s.remove)
  const promote = useMemoryStore((s) => s.promote)

  const [editing, setEditing] = useState(false)
  const [docOpen, setDocOpen] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const kindColor = KIND_COLOR[memory.kind]

  const handleDelete = () => {
    Alert.alert(
      'Excluir memória?',
      `"${memory.text}" será excluída permanentemente${memory.hasDoc ? ', junto com o documento anexado' : ''}.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => void remove(memory.id) },
      ],
    )
  }

  return (
    <View style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <Text style={[s.cardText, { color: tokens.foreground }]}>{memory.text}</Text>

      {/* Badges + tags */}
      <View style={s.badgesRow}>
        <View style={[s.kindBadge, { backgroundColor: `${kindColor}26` }]}>
          <Text style={[s.kindBadgeText, { color: kindColor }]}>{KIND_LABEL[memory.kind]}</Text>
        </View>
        {memory.kind === 'project' && memory.category && (
          <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
            <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>{CATEGORY_LABEL[memory.category]}</Text>
          </View>
        )}
        {memory.kind === 'project' && memory.projectName && (
          <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
            <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>{memory.projectName}</Text>
          </View>
        )}
        {memory.promotedFrom && (
          <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
            <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>promovida</Text>
          </View>
        )}
        {memory.hasDoc && <FileText size={12} color={tokens.mutedForeground} />}
        {memory.tags.map((tag) => (
          <Text key={tag} style={[s.tagText, { color: tokens.mutedForeground }]}>#{tag}</Text>
        ))}
      </View>

      {/* Peso / usos / datas */}
      <View style={s.metaRow}>
        <View style={s.weightMeta}>
          <Text style={[s.metaText, { color: tokens.mutedForeground }]}>peso</Text>
          <View style={[s.weightTrack, { backgroundColor: tokens.muted }]}>
            <View style={[s.weightFill, { width: `${Math.round(memory.weight * 100)}%` }]} />
          </View>
        </View>
        <Text style={[s.metaText, { color: tokens.mutedForeground }]}>{memory.hits} uso{memory.hits === 1 ? '' : 's'}</Text>
        <Text style={[s.metaText, { color: tokens.mutedForeground }]}>{formatDate(memory.createdAt)}</Text>
        {memory.expiresAt != null && <Text style={[s.metaText, { color: tokens.mutedForeground }]}>expira {formatDate(memory.expiresAt)}</Text>}
      </View>

      {/* Conectadas */}
      {related.length > 0 && (
        <View style={[s.relatedBox, { borderTopColor: tokens.border }]}>
          <View style={s.relatedHeader}>
            <Link2 size={11} color={tokens.mutedForeground} />
            <Text style={[s.metaText, { color: tokens.mutedForeground }]}>Conectadas</Text>
          </View>
          {related.map((r) => (
            <Pressable key={r.id} onPress={() => onSelectRelated?.(r.id)}>
              <Text style={[s.relatedText, { color: tokens.mutedForeground }]} numberOfLines={1}>• {r.text}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Ações — sempre visíveis no mobile */}
      <View style={[s.actionsRow, { borderTopColor: tokens.border }]}>
        {memory.hasDoc && (
          <Pressable onPress={() => setDocOpen(true)} style={s.actionBtn}>
            <FileText size={15} color={tokens.mutedForeground} />
          </Pressable>
        )}
        {canPromote(memory) && (
          <Pressable onPress={() => void promote(memory.id)} style={s.actionBtn}>
            <ArrowUpCircle size={15} color={tokens.mutedForeground} />
          </Pressable>
        )}
        <Pressable onPress={() => setEditing(true)} style={s.actionBtn}>
          <Pencil size={15} color={tokens.mutedForeground} />
        </Pressable>
        <Pressable onPress={handleDelete} style={s.actionBtn}>
          <Trash2 size={15} color="#ff3344" />
        </Pressable>
      </View>

      <EditModal memory={memory} visible={editing} onClose={() => setEditing(false)} />
      {memory.hasDoc && <DocModal memory={memory} visible={docOpen} onClose={() => setDocOpen(false)} />}
    </View>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, padding: 12, gap: 8 },
  cardText: { fontSize: 14, lineHeight: 20 },

  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  kindBadge: { borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 },
  kindBadgeText: { fontSize: 10, fontWeight: '600' },
  outlineBadge: { borderRadius: 9999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  outlineBadgeText: { fontSize: 10 },
  tagText: { fontSize: 11 },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  weightMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  weightTrack: { width: 56, height: 4, borderRadius: 2, overflow: 'hidden' },
  weightFill: { height: '100%', borderRadius: 2, backgroundColor: 'rgba(245,166,35,0.6)' },
  metaText: { fontSize: 11 },

  relatedBox: { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  relatedHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  relatedText: { fontSize: 12 },

  actionsRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4, borderTopWidth: 1, paddingTop: 8 },
  actionBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 24 },
  modalBox: { width: '100%', maxWidth: 400, borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  modalTitle: { fontSize: 16, fontWeight: '600' },
  modalInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  weightLabel: { fontSize: 12 },
  weightChips: { flexDirection: 'row', gap: 6, flex: 1, justifyContent: 'flex-end' },
  weightChip: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  cancelText: { fontSize: 14 },
  saveBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  saveText: { fontSize: 14, fontWeight: '600' },

  docBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  docSheet: { height: '80%', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, paddingHorizontal: 16, paddingTop: 8 },
  docHandle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'hsl(240 4% 25%)', marginBottom: 12 },
  docHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  docTitle: { flex: 1, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  docLoading: { fontSize: 13 },
})
