/**
 * Formulário de criar/editar esteira — espelho do EsteiraCreateDialog do
 * desktop, como rota: nome, pastas (FolderSelector), modelo padrão, fases
 * (adicionar dos templates via bottom sheet, reordenar por drag & drop,
 * editar, remover) e toggles de push/prints. Na criação o projeto nasce junto
 * (dono das pastas), com o mesmo nome — mesmo fluxo do desktop.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native'
import { useTranslation } from 'react-i18next'
import Animated from 'react-native-reanimated'
import { Brain, ChevronDown, GripVertical, Pencil, Plus, X } from 'lucide-react-native'
import type { Esteira, FaseConfig, FaseEscolhida, FaseTemplate } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Switch } from '~/components/ui/switch'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useEsteiraStore } from '~/stores/esteira-store'
import { FaseEditor } from './fase-editor'
import { ErroCarregamento } from './erro-carregamento'
import { doTemplate, rotuloTemplate } from './esteira-utils'
import { FaseLinhaArrastavel, FaseListaDragProvider, useFaseListaDrag } from './fase-lista-drag'

interface ModeloEscolhido {
  providerId: string
  modelId: string
}

/** Fase no formulário com chave estável — identidade atravessa reordenações
 *  do DnD (chaves por índice desmontariam as linhas no meio do arrasto). */
interface FaseLocal extends FaseEscolhida {
  chave: string
}

let chaveSeq = 0
const comChave = (fase: FaseEscolhida): FaseLocal => ({
  ...fase,
  chave: `fase_${++chaveSeq}_${Date.now().toString(36)}`,
})

interface EsteiraFormProps {
  /** Esteira em edição — ausente = criação nova. */
  editando?: Esteira | null
  onConcluida: (esteira: Esteira) => void
  onCancelar: () => void
}

export function EsteiraForm(props: EsteiraFormProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const carregado = useEsteiraStore((s) => s.carregado)
  const erro = useEsteiraStore((s) => s.erro)
  const fetch = useEsteiraStore((s) => s.fetch)

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  // O formulário precisa dos templates para montar as fases iniciais — só
  // monta depois que o snapshot chega, e o estado inicial sai direto dos
  // props/store (sem efeito de reset). Erro de fetch vira tela com retry
  // (nunca spinner infinito).
  if (!carregado) {
    if (erro) {
      return <ErroCarregamento />
    }
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    )
  }
  return <EsteiraFormCarregada {...props} />
}

/** Dono do estado das fases: o FaseListaDragProvider precisa do onMover no
 *  escopo que monta o provider (o contexto do drag fica disponível ao corpo). */
function EsteiraFormCarregada(props: EsteiraFormProps) {
  const { t } = useTranslation()
  const templates = useEsteiraStore((s) => s.templates)

  // Edição parte das fases REAIS da esteira (já são cópias, D4); criação nova
  // só com as fases padrão — as demais ficam atrás do "+".
  const [fases, setFases] = useState<FaseLocal[]>(() =>
    props.editando
      ? props.editando.fases.map((f) =>
          comChave({
            templateId: templates.find((tpl) => tpl.nome === f.nome)?.id,
            nome: f.nome,
            descricao: f.descricao,
            prompt: f.prompt,
            tools: [...f.tools],
            tipo: f.tipo ?? 'generico',
          }),
        )
      : templates.filter((tpl) => tpl.padrao).map((tpl) => comChave(doTemplate(tpl, t))),
  )

  const mover = useCallback((de: number, para: number) => {
    setFases((atual) => {
      if (de === para || de < 0 || para < 0 || de >= atual.length || para > atual.length) return atual
      const proximo = [...atual]
      const [movida] = proximo.splice(de, 1)
      proximo.splice(para, 0, movida)
      return proximo
    })
  }, [setFases])

  return (
    <FaseListaDragProvider fases={fases} onMover={mover}>
      <FormEsteiraCorpo {...props} fases={fases} setFases={setFases} />
    </FaseListaDragProvider>
  )
}

function FormEsteiraCorpo({
  editando,
  onConcluida,
  onCancelar,
  fases,
  setFases,
}: EsteiraFormProps & {
  fases: FaseLocal[]
  setFases: React.Dispatch<React.SetStateAction<FaseLocal[]>>
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)

  const templates = useEsteiraStore((s) => s.templates)
  const projetos = useEsteiraStore((s) => s.projetos)
  const criarProjeto = useEsteiraStore((s) => s.criarProjeto)
  const atualizarProjeto = useEsteiraStore((s) => s.atualizarProjeto)
  const criarEsteira = useEsteiraStore((s) => s.criarEsteira)
  const atualizarEsteira = useEsteiraStore((s) => s.atualizarEsteira)
  const salvarTemplate = useEsteiraStore((s) => s.salvarTemplate)

  const { scrollViewRef, handleScroll, handleScrollEnd, contentHeight } = useFaseListaDrag()

  const [nome, setNome] = useState(editando?.nome ?? '')
  const [pastas, setPastas] = useState<string[]>(
    editando ? (projetos.find((p) => p.id === editando.projetoId)?.pastas ?? []) : [],
  )
  const [pushAoFinal, setPushAoFinal] = useState(editando?.pushAoFinal ?? false)
  const [prints, setPrints] = useState(editando?.printsDoResultado ?? false)
  // Edição parte do modelo REAL da esteira (todas as fases o compartilham);
  // sem isto o form abria sem modelo e o "Modelo padrão" ficava vazio.
  const [modelo, setModelo] = useState<ModeloEscolhido | null>(() =>
    editando?.fases[0]
      ? { providerId: editando.fases[0].providerId, modelId: editando.fases[0].modelId }
      : null,
  )
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const [modeloPickerAberto, setModeloPickerAberto] = useState(false)
  const [adicionarFaseAberto, setAdicionarFaseAberto] = useState(false)
  const [editandoFase, setEditandoFase] = useState<{ indice: number | null; fase: FaseEscolhida | null } | null>(null)

  const nomeModelo = modelo
    ? (catalog?.[modelo.providerId]?.models[modelo.modelId]?.name ?? modelo.modelId)
    : null

  const disponiveis = templates.filter((tpl) => !fases.some((f) => f.templateId === tpl.id))

  const salvarFase = useCallback(
    async (fase: FaseEscolhida, comoPadrao: boolean) => {
      const indice = editandoFase?.indice ?? null
      setFases((atual) =>
        indice == null
          ? [...atual, comChave(fase)]
          : atual.map((f, i) => (i === indice ? { ...fase, chave: f.chave } : f)),
      )
      if (comoPadrao && fase.templateId) {
        await salvarTemplate({
          id: fase.templateId,
          nome: fase.nome,
          descricao: fase.descricao,
          prompt: fase.prompt,
          tools: fase.tools,
          tipo: fase.tipo,
          // Mantém a fase entre as sugeridas se já era, para o padrão não sumir
          padrao: templates.find((tpl) => tpl.id === fase.templateId)?.padrao ?? false,
        })
      }
      setEditandoFase(null)
    },
    [editandoFase, templates, salvarTemplate, setFases],
  )

  const podeCriar =
    nome.trim().length > 0 && fases.length > 0 && !!modelo && pastas.length > 0 && !salvando

  const salvar = async () => {
    if (!podeCriar || !modelo) return
    setSalvando(true)
    setErro(null)
    try {
      if (editando) {
        // Edição não recria a esteira: mantém id, tasks e histórico. As fases
        // viram FaseConfig preservando o modelo já configurado por fase.
        await atualizarEsteira(editando.id, {
          nome: nome.trim(),
          pushAoFinal,
          printsDoResultado: prints,
          fases: fases.map((fase, ordem): FaseConfig => {
            const anterior = editando.fases[ordem]
            return {
              id: anterior?.id ?? `fase_${ordem}_${Date.now().toString(36)}`,
              nome: fase.nome,
              descricao: fase.descricao,
              prompt: fase.prompt,
              // O "Modelo padrão" vale para o pipeline inteiro (sem override
              // por fase na UI): mudá-lo troca o modelo de todas as fases.
              // Antes `anterior ?? modelo` mantinha o modelo velho.
              providerId: modelo.providerId,
              modelId: modelo.modelId,
              thinkingNivel: anterior?.thinkingNivel ?? 0,
              tools: [...fase.tools],
              tipo: fase.tipo,
              ordem,
            }
          }),
        })
        await atualizarProjeto(editando.projetoId, { pastas })
        onConcluida(editando)
        return
      }
      // O projeto é o dono das pastas — nasce junto, com o mesmo nome.
      const projeto = await criarProjeto(nome.trim(), pastas)
      const esteira = await criarEsteira({
        projetoId: projeto.id,
        nome: nome.trim(),
        fases: fases.map(({ chave: _chave, ...fase }) => fase),
        providerId: modelo.providerId,
        modelId: modelo.modelId,
        pushAoFinal,
        printsDoResultado: prints,
      })
      onConcluida(esteira)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.ScrollView
        ref={scrollViewRef}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onScrollEndDrag={handleScrollEnd}
        onMomentumScrollEnd={handleScrollEnd}
        contentContainerStyle={{ minHeight: contentHeight, padding: 16, gap: 14, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.nomeEsteira')}</Text>
          <Input value={nome} onChangeText={setNome} placeholder={t('esteira.nomeExemplo')} />
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.pastas')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.pastasDica')}</Text>
          <FolderSelector folders={pastas} onFoldersChange={setPastas} />
          {pastas.length > 0 && (
            <Text style={[s.dica, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {t('esteira.repositorioPrincipal')}: <Text style={{ color: tokens.foreground }}>{pastas[0]}</Text>
            </Text>
          )}
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.modeloPadrao')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.modeloDica')}</Text>
          <Pressable
            onPress={() => setModeloPickerAberto(true)}
            style={({ pressed }) => [
              s.modeloTrigger,
              { backgroundColor: pressed ? tokens.muted : tokens.card, borderColor: tokens.border },
            ]}
          >
            <View style={s.modeloTriggerEsquerda}>
              {modelo?.providerId ? (
                <ProviderLogo providerId={modelo.providerId} size={14} color={tokens.mutedForeground} />
              ) : (
                <Brain size={14} color={tokens.mutedForeground} />
              )}
              <Text style={[s.modeloTexto, { color: nomeModelo ? tokens.foreground : tokens.mutedForeground }]} numberOfLines={1}>
                {nomeModelo ?? t('esteira.modeloPadrao')}
              </Text>
            </View>
            <ChevronDown size={15} color={tokens.mutedForeground} />
          </Pressable>
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.fases')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.fasesDica')}</Text>
          {/* As linhas do sortable são position:absolute (a lib as posiciona via
              top) — o wrapper precisa da altura exata da lista, senão o que vem
              depois (adicionar fase, switches) flui por cima dos cards. */}
          <View style={{ height: contentHeight }}>
            {fases.map((fase, indice) => (
              <FaseLinhaArrastavel key={fase.chave} chave={fase.chave} indice={indice}>
                <FaseLinhaConteudo
                  fase={fase}
                  tokens={tokens}
                  onEditar={() => setEditandoFase({ indice, fase })}
                  onRemover={() => setFases((atual) => atual.filter((_, i) => i !== indice))}
                />
              </FaseLinhaArrastavel>
            ))}
          </View>
          <Pressable
            onPress={() => setAdicionarFaseAberto(true)}
            style={[s.adicionarFase, { borderColor: tokens.border }]}
          >
            <Plus size={13} color={tokens.mutedForeground} />
            <Text style={[s.adicionarFaseTexto, { color: tokens.mutedForeground }]}>
              {t('esteira.adicionarFase')}
            </Text>
          </Pressable>
        </View>

        <View style={{ gap: 10 }}>
          <View style={s.switchLinha}>
            <Switch checked={pushAoFinal} onCheckedChange={setPushAoFinal} />
            <Text style={[s.switchTexto, { color: tokens.foreground }]}>{t('esteira.push')}</Text>
          </View>
          <View style={s.switchLinha}>
            <Switch checked={prints} onCheckedChange={setPrints} />
            <Text style={[s.switchTexto, { color: tokens.foreground }]}>{t('esteira.prints')}</Text>
          </View>
        </View>

        {erro && (
          <Text style={[s.erro, { color: tokens.destructive }]}>{erro}</Text>
        )}

        <View style={s.rodape}>
          <Pressable onPress={onCancelar} style={s.botaoSecundario}>
            <Text style={[s.botaoSecundarioTexto, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void salvar()}
            disabled={!podeCriar}
            style={[s.botaoPrimario, { backgroundColor: tokens.primary, opacity: podeCriar ? 1 : 0.4 }]}
          >
            {salvando ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Text style={[s.botaoPrimarioTexto, { color: tokens.primaryForeground }]}>
                {editando ? t('esteira.salvar') : t('esteira.criar')}
              </Text>
            )}
          </Pressable>
        </View>
      </Animated.ScrollView>

      <ModelPickerModal
        visible={modeloPickerAberto}
        onClose={() => setModeloPickerAberto(false)}
        selected={modelo}
        onSelect={(providerId, modelId) => setModelo({ providerId, modelId })}
      />

      <BottomSheet
        aberto={adicionarFaseAberto}
        aoFechar={() => setAdicionarFaseAberto(false)}
        titulo={
          <Text style={[s.sheetTitulo, { color: tokens.foreground }]}>{t('esteira.adicionarFase')}</Text>
        }
      >
        <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
          {disponiveis.map((tpl: FaseTemplate) => {
            const rotulo = rotuloTemplate(tpl, t)
            return (
              <Pressable
                key={tpl.id}
                onPress={() => {
                  setFases((atual) => [...atual, comChave(doTemplate(tpl, t))])
                  setAdicionarFaseAberto(false)
                }}
                style={[s.faseOpcao, { borderBottomColor: tokens.border }]}
              >
                <Text style={[s.faseOpcaoNome, { color: tokens.foreground }]} numberOfLines={1}>
                  {rotulo.nome}
                </Text>
                <Text style={[s.faseOpcaoDesc, { color: tokens.mutedForeground }]} numberOfLines={2}>
                  {rotulo.descricao}
                </Text>
              </Pressable>
            )
          })}
          <Pressable
            onPress={() => {
              setAdicionarFaseAberto(false)
              setEditandoFase({ indice: null, fase: null })
            }}
            style={[s.faseOpcao, { borderBottomWidth: 0 }]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Plus size={14} color={tokens.foreground} />
              <Text style={[s.faseOpcaoNome, { color: tokens.foreground }]}>{t('esteira.criarFase')}</Text>
            </View>
          </Pressable>
        </ScrollView>
      </BottomSheet>

      {editandoFase && (
        <FaseEditor
          key={`${editandoFase.indice ?? 'nova'}-${editandoFase.fase?.templateId ?? 'custom'}`}
          fase={editandoFase.fase}
          onFechar={() => setEditandoFase(null)}
          onSalvar={salvarFase}
        />
      )}
    </KeyboardAvoidingView>
  )
}

/** Linha da fase: alça (arrastar), nome/descrição (toque abre o editor),
 *  lápis e remover. O drag em si vem do FaseLinhaArrastavel por cima. */
function FaseLinhaConteudo({
  fase,
  tokens,
  onEditar,
  onRemover,
}: {
  fase: FaseEscolhida
  tokens: Record<string, string>
  onEditar?: () => void
  onRemover?: () => void
}) {
  return (
    <View style={[s.faseLinha, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <GripVertical size={14} color={tokens.mutedForeground} style={{ opacity: 0.55 }} />
      <Pressable onPress={onEditar} disabled={!onEditar} style={{ minWidth: 0, flex: 1, gap: 1 }}>
        <Text style={[s.faseNome, { color: tokens.foreground }]} numberOfLines={1}>
          {fase.nome}
        </Text>
        <Text style={[s.faseDesc, { color: tokens.mutedForeground }]} numberOfLines={1}>
          {fase.descricao}
        </Text>
      </Pressable>
      <Pressable onPress={onEditar} disabled={!onEditar} hitSlop={8}>
        <Pencil size={14} color={tokens.mutedForeground} />
      </Pressable>
      <Pressable onPress={onRemover} disabled={!onRemover} hitSlop={8}>
        <X size={14} color={tokens.mutedForeground} />
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  campo: { gap: 6 },
  rotulo: { fontSize: 12, fontWeight: '600' },
  dica: { fontSize: 11, lineHeight: 15 },
  modeloTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modeloTriggerEsquerda: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 },
  modeloTexto: { fontSize: 13, fontWeight: '500', flex: 1 },
  adicionarFase: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    paddingVertical: 8,
    marginTop: 8,
  },
  adicionarFaseTexto: { fontSize: 11 },
  switchLinha: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchTexto: { fontSize: 13 },
  erro: { fontSize: 12, lineHeight: 17 },
  rodape: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  botaoSecundario: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  botaoSecundarioTexto: { fontSize: 13, fontWeight: '500' },
  botaoPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  botaoPrimarioTexto: { fontSize: 13, fontWeight: '600' },
  faseOpcao: { paddingVertical: 10, borderBottomWidth: 1 },
  faseOpcaoNome: { fontSize: 13, fontWeight: '500' },
  faseOpcaoDesc: { fontSize: 11, lineHeight: 15, marginTop: 1 },
  faseLinha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  faseNome: { fontSize: 12, fontWeight: '500' },
  faseDesc: { fontSize: 11 },
  sheetTitulo: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
})
