import { Modal, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ScanLine, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ConnectionConfig } from '@orbit/companion-client'
import { QRScannerWrapper } from './QRScannerWrapper'

interface QRScannerModalProps {
  visible: boolean
  onClose: () => void
  onScanned: (config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => void
}

/**
 * Overlay de leitura de QR Code em tela cheia. Cobre toda a tela com a câmera
 * (padrão dos apps de scanner): header com título + fechar, área da câmera
 * ocupando o meio e dica no rodapé.
 */
export function QRScannerModal({ visible, onClose, onScanned }: QRScannerModalProps) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <View style={s.headerTitle}>
            <ScanLine size={18} color="#fff" />
            <Text style={s.headerText}>{t('connectionScreen.scanQrCode')}</Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('qrScanner.close')}
            style={s.closeBtn}
          >
            <X size={20} color="#fff" />
          </Pressable>
        </View>

        <View style={s.camera}>
          <QRScannerWrapper onScanned={onScanned} />
        </View>

        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Text style={s.footerText}>{t('qrScanner.hint')}</Text>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  camera: { flex: 1 },
  footer: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 14 },
  footerText: { fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
})
