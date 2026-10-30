/**
 * New pipeline — mirror of the desktop PipelineCreateDialog as a route: the
 * PipelineForm creates the project (owner of the folders) together with the
 * pipeline. When it finishes, it opens the board of the pipeline created.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { PipelineForm } from '~/components/pipeline/pipeline-form'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

export default function NewPipelineScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerButton}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('pipeline.newPipeline')}</Text>
        <View style={s.headerButton} />
      </View>
      <PipelineForm
        onDone={(pipeline) => router.replace(`/(main)/pipeline/${pipeline.id}`)}
        onCancel={() => router.back()}
      />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
})
