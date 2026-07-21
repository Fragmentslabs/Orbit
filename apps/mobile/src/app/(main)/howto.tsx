import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ArrowLeft, Search, Globe, Brain, AlignLeft, BrainCircuit, Bot, Network, RefreshCw, FileText, KeyRound, BookOpen } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface ModeInfo {
  icon: typeof Search
  label: string
  modes: string[]
  description: string
  detail: string
  combo?: string[]
}

const MODES: ModeInfo[] = [
  { icon: Search, label: 'Pesquisa', modes: ['Chat', 'Código'], description: 'Busca e lê páginas da web via HTTP.', detail: 'Adiciona as ferramentas websearch e webfetch ao agente. Rápido para consultar documentação e APIs.', combo: ['Browser', 'Thinking'] },
  { icon: Globe, label: 'Browser', modes: ['Chat'], description: 'Navega em páginas como um browser real.', detail: 'Abre o painel direito com um navegador completo. Executa JavaScript, ideal para SPAs e páginas dinâmicas.', combo: ['Pesquisa', 'Thinking'] },
  { icon: Brain, label: 'Thinking', modes: ['Chat', 'Código'], description: 'Raciocínio estendido do modelo.', detail: 'O modelo \"pensa\" antes de responder, resultando em respostas mais profundas. Consome mais tokens.', combo: ['Pesquisa', 'Browser', 'Loop'] },
  { icon: AlignLeft, label: 'Simples', modes: ['Chat', 'Código'], description: 'Respostas diretas em texto puro.', detail: 'Remove formatação avançada e blocos de ferramentas da resposta.', combo: [] },
  { icon: BrainCircuit, label: 'Memória (Brain)', modes: ['Chat', 'Código'], description: 'Orbit lembra fatos e preferências entre conversas.', detail: 'Adiciona ferramentas de memória. O Orbit pode salvar e recuperar fatos automaticamente.', combo: [] },
  { icon: Bot, label: 'Subagents', modes: ['Chat', 'Código'], description: 'Workers efêmeros para tarefas paralelas.', detail: 'O agente delega subtarefas a workers em background. Eles são descartados ao fim da tarefa.', combo: ['Loop', 'Orchestra'] },
  { icon: Network, label: 'Orchestra', modes: ['Chat', 'Código'], description: 'Divide o pedido em plano + workers persistentes.', detail: 'O orquestrador planeja, você aprova, e cada tarefa vira uma sessão filha no painel direito.', combo: ['Loop', 'Subagents'] },
  { icon: RefreshCw, label: 'Loop', modes: ['Código'], description: 'Agente revisa e itera até completar a tarefa.', detail: 'Após cada resposta, o sistema revisa o resultado. Se incompleto, o agente continua automaticamente.', combo: ['Subagents', 'Orchestra', 'Thinking'] },
  { icon: FileText, label: 'Modo Plano', modes: ['Código'], description: 'Apenas leitura — produz um plano sem editar.', detail: 'Bloqueia ferramentas de escrita. O agente lê o código e produz um plano detalhado.', combo: ['Thinking', 'Pesquisa'] },
  { icon: KeyRound, label: 'Permissões', modes: ['Código'], description: 'Controle de segurança sobre ações do agente.', detail: 'Três níveis: Ask (pergunta), Approve (resumo), Full (automático).', combo: [] },
]

const COMBOS: { label: string; items: string[]; description: string }[] = [
  { label: 'Pesquisa aprofundada', items: ['Pesquisa', 'Browser', 'Thinking'], description: 'O agente search, navega em páginas dinâmicas e raciocina profundamente. Ideal para investigar tópicos técnicos.' },
  { label: 'Refinamento automático', items: ['Loop', 'Thinking'], description: 'O agente revisa o próprio resultado com raciocínio estendido. Excelente para gerar código robusto.' },
  { label: 'Orquestração com revisão', items: ['Orchestra', 'Loop'], description: 'Workers executam em paralelo e o loop revisa o resultado, criando continuações se necessário.' },
  { label: 'Workers em múltiplas frentes', items: ['Orchestra', 'Subagents'], description: 'O orquestrador coordena tarefas de alto nível e cada worker pode usar subagents para investigações pontuais.' },
  { label: 'Planejamento cuidadoso', items: ['Modo Plano', 'Thinking', 'Pesquisa'], description: 'Antes de alterar, o agente pesquisa, raciocina e produz um plano sem modificar arquivos.' },
]

export default function HowToScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>Como funciona</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>Modos e Ferramentas</Text>
        <Text style={[s.sectionDesc, { color: tokens.mutedForeground }]}>
          O Orbit oferece vários modos que modificam o comportamento do agente. Ative-os antes de enviar a mensagem.
        </Text>

        {MODES.map((mode) => {
          const Icon = mode.icon
          return (
            <View key={mode.label} style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              <View style={s.cardHeader}>
                <Icon size={18} color={tokens.primary} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>{mode.label}</Text>
                <View style={s.badges}>
                  {mode.modes.map((m) => (
                    <Text key={m} style={[s.badge, { backgroundColor: tokens.border, color: tokens.mutedForeground }]}>{m}</Text>
                  ))}
                </View>
              </View>
              <Text style={[s.cardDesc, { color: tokens.mutedForeground }]}>{mode.description}</Text>
              <Text style={[s.cardDetail, { color: tokens.foreground }]}>{mode.detail}</Text>
              {mode.combo && mode.combo.length > 0 && (
                <Text style={[s.combo, { color: tokens.mutedForeground }]}>Combina bem com: {mode.combo.join(', ')}</Text>
              )}
            </View>
          )
        })}

        <Text style={[s.sectionTitle, { color: tokens.mutedForeground, marginTop: 24 }]}>Combinações Recomendadas</Text>

        {COMBOS.map((combo) => (
          <View key={combo.label} style={[s.comboCard, { borderColor: tokens.border, backgroundColor: tokens.accent }]}>
            <View style={s.comboItems}>
              {combo.items.map((item) => {
                const m = MODES.find((x) => x.label === item)
                const Icon = m?.icon ?? BookOpen
                return (
                  <View key={item} style={[s.comboChip, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
                    <Icon size={12} color={tokens.foreground} />
                    <Text style={[s.comboChipLabel, { color: tokens.foreground }]}>{item}</Text>
                  </View>
                )
              })}
            </View>
            <Text style={[s.cardDetail, { color: tokens.foreground }]}>{combo.description}</Text>
          </View>
        ))}

        {/* Tip */}
        <View style={[s.tipBox, { borderColor: tokens.primary, backgroundColor: tokens.primary + '12' }]}>
          <Text style={[s.tipTitle, { color: tokens.primary }]}>Dica</Text>
          <Text style={[s.tipText, { color: tokens.mutedForeground }]}>
            Use os toggles abaixo do input para ativar/desativar modos rapidamente, ou o botão "+" para acessar configurações avançadas de Subagents, Orchestra e Loop.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  sectionDesc: { fontSize: 12, marginBottom: 16, lineHeight: 18 },
  card: { borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardLabel: { fontSize: 14, fontWeight: '600', flex: 1 },
  badges: { flexDirection: 'row', gap: 4 },
  badge: { fontSize: 10, fontWeight: '500', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  cardDesc: { fontSize: 12, opacity: 0.7 },
  cardDetail: { fontSize: 12, lineHeight: 18 },
  combo: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  comboCard: { borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, gap: 8 },
  comboItems: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  comboChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  comboChipLabel: { fontSize: 11, fontWeight: '500' },
  tipBox: { borderRadius: 14, padding: 14, marginTop: 8, borderWidth: 1, gap: 4 },
  tipTitle: { fontSize: 12, fontWeight: '600' },
  tipText: { fontSize: 12, lineHeight: 18 },
})
