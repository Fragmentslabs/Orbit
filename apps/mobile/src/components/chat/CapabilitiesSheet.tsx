import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react-native'
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  type CapabilityGroup,
  type CapabilityMode,
  type CapabilityRequirement,
  type MediaKind,
} from '@orbit/shared'
import { CapabilityIcon } from '~/components/chat/CapabilityIcon'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface Props {
  visible: boolean
  onClose: () => void
  mode: CapabilityMode
  features: { tts: boolean; stt: boolean; browser: boolean }
  usedKinds: readonly MediaKind[]
  /** "Try it": the screen fills the composer with the example and closes the sheet. */
  onPick: (example: string) => void
}

/**
 * "What does Orbit do?" — the capability map the start screen's quiet link opens. A sheet over the
 * screen, not navigation, so what was typed in the composer survives; "Try it" fills the field and
 * sends nothing. A feature that is off on the desktop shows why instead of promising an example.
 */
export function CapabilitiesSheet({ visible, onClose, mode, features, usedKinds, onPick }: Props) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const [group, setGroup] = useState<CapabilityGroup>(CAPABILITY_GROUPS[0] ?? 'create')

  const isOn = (requirement: CapabilityRequirement) => features[requirement]
  const items = CAPABILITIES.filter((capability) => capability.group === group && capability.modes.includes(mode))

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel={t('chat.start.close')}
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' }}
        />
        <View
          style={{
            maxHeight: '82%',
            backgroundColor: tokens.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: tokens.border,
            paddingBottom: insets.bottom + 8,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: tokens.border }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', color: tokens.foreground }}>{t('chat.start.title')}</Text>
              <Text style={{ marginTop: 4, fontSize: 13, lineHeight: 19, color: tokens.mutedForeground }}>{t('chat.start.subtitle')}</Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('chat.start.close')}
              hitSlop={10}
              style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 20, paddingBottom: 10 }}>
            {CAPABILITY_GROUPS.map((id) => {
              const on = id === group
              return (
                <Pressable
                  key={id}
                  onPress={() => setGroup(id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  style={{
                    minHeight: 36,
                    paddingHorizontal: 14,
                    borderRadius: 18,
                    borderWidth: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderColor: on ? tokens.foreground : tokens.border,
                    backgroundColor: on ? tokens.foreground : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: on ? '600' : '500', color: on ? tokens.background : tokens.foreground }}>
                    {t(`chat.start.groups.${id}`)}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}>
            {items.map((capability) => {
              const example = capability.hasExample ? (t(`chat.start.items.${capability.id}.example`) as string) : null
              const off = capability.requires ? !isOn(capability.requires) : false
              const fresh = capability.produces !== undefined && !usedKinds.includes(capability.produces)
              return (
                <View
                  key={capability.id}
                  style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: tokens.border }}
                >
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: tokens.muted, alignItems: 'center', justifyContent: 'center' }}>
                    <CapabilityIcon capability={capability.id} size={18} color={tokens.foreground} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: tokens.foreground }}>
                        {t(`chat.start.items.${capability.id}.label`)}
                      </Text>
                      {fresh && !off ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.primary }} /> : null}
                    </View>
                    <Text style={{ marginTop: 3, fontSize: 13, lineHeight: 19, color: tokens.mutedForeground }}>
                      {t(`chat.start.items.${capability.id}.desc`)}
                    </Text>
                    {off ? (
                      <Text style={{ marginTop: 3, fontSize: 12, lineHeight: 17, color: tokens.mutedForeground }}>{t('chat.start.disabledHint')}</Text>
                    ) : !example ? (
                      <Text style={{ marginTop: 3, fontSize: 12, lineHeight: 17, color: tokens.mutedForeground }}>
                        {t(`chat.start.items.${capability.id}.howTo`)}
                      </Text>
                    ) : null}
                  </View>
                  {!off && example ? (
                    <Pressable
                      onPress={() => onPick(example)}
                      accessibilityRole="button"
                      style={{ alignSelf: 'center', minHeight: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: tokens.border, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.foreground }}>{t('chat.start.tryIt')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              )
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
