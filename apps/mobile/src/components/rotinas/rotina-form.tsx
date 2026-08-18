import { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowLeft, Folder, MessageSquare, Sparkles } from 'lucide-react-native'
import type { Agenda, Rotina, RotinaModelo, RotinaModos, RotinaSugestao } from '@orbit/shared'
import { parseHorario, ROTINA_MODOS_CHAT, ROTINA_PERMISSAO_PADRAO } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Skeleton } from '~/components/ui/skeleton'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { useSettingsStore } from '~/stores/settings-store'
import { useRotinasStore } from '~/stores/rotinas-store'
import { useSessionModel } from '~/stores/session-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { AgendaEditor, ModosEditor } from './agenda-editor'
import { RotinaModelPicker } from './rotina-model-picker'

/**
 * Formulário das rotinas — compartilhado pela criação e pela edição.
 *
 * Criação (sem `rotina`): duas etapas dentro da mesma tela, como o modal do
 * desktop —
 *   1. Descrever — texto livre + modelo, e só isso
 *   2. Revisar   — o que o modelo propôs, tudo editável antes de confirmar
 * A etapa 2 nunca é pulada: o agente SUGERE e quem decide é o usuário.
 *
 * Edição (com `rotina`): já abre na revisão com os campos preenchidos.
 */
export function RotinaForm({
  mode,
  rotina,
  onConcluida,
}: {
  /** Modo da rotina — fixo na criação (vem da tela), herdado na edição. */
  mode: 'chat' | 'code'
  /** Presente na edição; ausente na criação. */
  rotina?: Rotina
  onConcluida: (rotina: Rotina) => void
}) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const rotinas = useRotinasStore((s) => s.rotinas)
  const gerar = useRotinasStore((s) => s.gerar)
  const criar = useRotinasStore((s) => s.criar)
  const atualizar = useRotinasStore((s) => s.atualizar)
  // Modelo de visão configurado nas preferências: é o que a rotina guarda
  // quando o modo Visão está ligado (o main não lê o localStorage).
  const visionModel = useSettingsStore((s) => s.visionModel)
  const visionDisponivel = !!visionModel

  // Etapa 1 (criação)
  const [descricao, setDescricao] = useState('')
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [sugestao, setSugestao] = useState<RotinaSugestao | null>(null)

  // Modelo padrão da criação: o da última rotina criada > o do último chat.
  // A rotina anterior vem primeiro porque é o contexto mais próximo do que o
  // usuário está fazendo agora — quem monta a segunda rotina quer o mesmo
  // modelo da primeira.
  const ultima = [...rotinas].sort((a, b) => b.criadoEm - a.criadoEm)[0]
  const modeloDraft = useSessionModel(null)
  const [modelo, setModelo] = useState<RotinaModelo | null>(rotina?.modelo ?? ultima?.modelo ?? modeloDraft)

  // Pastas são escolhidas NA ETAPA 1, junto com o modelo — a geração já usa
  // essas pastas como contexto do prompt. Só existem no modo código.
  const [pastas, setPastas] = useState<string[]>(rotina?.mode === 'code' ? rotina.pastas : [])

  // Campos da revisão (partem da sugestão/rotina, mas seguem a edição)
  const [titulo, setTitulo] = useState(rotina?.titulo ?? '')
  const [prompt, setPrompt] = useState(rotina?.prompt ?? '')
  const [agenda, setAgenda] = useState<Agenda>(rotina?.agenda ?? { horario: '09:00' })
  const [modos, setModos] = useState<RotinaModos>(
    rotina?.modos ?? { permissionMode: ROTINA_PERMISSAO_PADRAO },
  )
  const [salvando, setSalvando] = useState(false)

  const podeGerar = descricao.trim().length > 0 && !!modelo && !gerando

  const handleGerar = async () => {
    if (!podeGerar || !modelo) return
    setGerando(true)
    setErro(null)
    try {
      // Nome do idioma em inglês, usado nos system prompts enviados ao modelo
      // (mesmo do desktop: LOCALE_PROMPT_NAME).
      const idioma = i18n.language.toLowerCase().startsWith('pt') ? 'Portuguese' : 'English'
      const resultado = await gerar(descricao.trim(), modelo, pastas, idioma, mode, visionDisponivel)
      if (!resultado.ok) {
        setErro(resultado.erro)
        return
      }
      setSugestao(resultado.sugestao)
      setTitulo(resultado.sugestao.titulo)
      setPrompt(resultado.sugestao.prompt)
      setAgenda(resultado.sugestao.agenda)
      setModos(resultado.sugestao.modos)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setGerando(false)
    }
  }

  // Pasta é obrigatória só no modo código: o scheduler recusa disparar uma
  // rotina sem pasta de trabalho — sem essa checagem aqui, a rotina seria
  // criada e nunca rodaria, sem nenhum aviso na hora.
  const podeSalvar =
    !!modelo &&
    titulo.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!parseHorario(agenda.horario) &&
    (mode === 'chat' || pastas.length > 0) &&
    !salvando

  const handleCriar = async () => {
    if (!podeSalvar || !modelo) return
    setSalvando(true)
    try {
      const criada = await criar({
        titulo: titulo.trim(),
        prompt: prompt.trim(),
        agenda,
        modelo,
        // Visão só funciona com o modelo de visão configurado — se o usuário
        // ligou o badge na revisão sem ter um, o modo sai desligado da criação
        // (o scheduler não teria o que enviar em `visionModel`).
        modos: modos.vision && !visionModel ? { ...modos, vision: undefined } : modos,
        mode,
        pastas: mode === 'chat' ? [] : pastas,
        visionModel: modos.vision ? (visionModel ?? undefined) : undefined,
        ativa: true,
      })
      onConcluida(criada)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setSalvando(false)
    }
  }

  const handleSalvar = async () => {
    if (!podeSalvar || !modelo || !rotina) return
    setSalvando(true)
    try {
      await atualizar(rotina.id, {
        titulo: titulo.trim(),
        prompt: prompt.trim(),
        agenda,
        modos,
        modelo,
      })
      onConcluida({ ...rotina, titulo: titulo.trim(), prompt: prompt.trim(), agenda, modos, modelo })
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setSalvando(false)
    }
  }

  const naRevisao = !!sugestao || !!rotina
  const destaqueErro = { backgroundColor: hslToRgba(tokens.destructive.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), 0.1) }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
      {!naRevisao ? (
        <>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('rotinas.criar.descreverDica')}</Text>
          <Textarea
            value={descricao}
            onChangeText={setDescricao}
            placeholder={t(mode === 'chat' ? 'rotinas.criar.placeholderChat' : 'rotinas.criar.placeholder')}
            placeholderTextColor={tokens.mutedForeground}
            style={{ minHeight: 120, maxHeight: 240 }}
            editable={!gerando}
          />

          {erro && (
            <View style={[s.erroBox, { borderColor: tokens.destructive }, destaqueErro]}>
              <AlertCircle size={14} color={tokens.destructive} />
              <Text style={[s.erroText, { color: tokens.destructive }]}>{erro}</Text>
            </View>
          )}

          {gerando && (
            <View style={[s.gerandoBox, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </View>
          )}

          <View style={s.etapa1Row}>
            {mode === 'code' && (
              <View style={{ flex: 1 }}>
                <FolderSelector folders={pastas} onFoldersChange={setPastas} />
              </View>
            )}
            <RotinaModelPicker value={modelo} onChange={setModelo} />
          </View>
          {!modelo && <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('rotinas.criar.semModelo')}</Text>}

          <Pressable
            onPress={() => void handleGerar()}
            disabled={!podeGerar}
            style={[s.botaoPrincipal, { backgroundColor: tokens.primary }, !podeGerar && { opacity: 0.4 }]}
          >
            {gerando ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Sparkles size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.botaoTexto, { color: tokens.primaryForeground }]}>
              {gerando ? t('rotinas.criar.gerando') : t('rotinas.criar.gerar')}
            </Text>
          </Pressable>

          {/* Dica do modo fica abaixo do botão, ocupando a largura toda. */}
          {mode === 'chat' ? (
            <View style={s.modoDica}>
              <MessageSquare size={14} color={tokens.mutedForeground} />
              <Text style={[s.dica, { color: tokens.mutedForeground, flex: 1 }]}>{t('rotinas.criar.modoChatDica')}</Text>
            </View>
          ) : (
            pastas.length === 0 && (
              <Text style={[s.dica, { color: tokens.mutedForeground }]}>
                {t('rotinas.revisar.semPastas')}
              </Text>
            )
          )}
        </>
      ) : (
        <>
          {!rotina && (
            <Pressable onPress={() => setSugestao(null)} style={s.voltarRow}>
              <ArrowLeft size={14} color={tokens.mutedForeground} />
              <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('rotinas.revisar.voltar')}</Text>
            </Pressable>
          )}

          <Campo rotulo={t('rotinas.revisar.campoTitulo')}>
            <Input value={titulo} onChangeText={setTitulo} />
          </Campo>

          <Campo rotulo={t('rotinas.revisar.campoPrompt')} dica={t('rotinas.revisar.campoPromptDica')}>
            <Textarea value={prompt} onChangeText={setPrompt} style={{ minHeight: 100, maxHeight: 220 }} />
          </Campo>

          <Campo rotulo={t('rotinas.revisar.agenda')}>
            <AgendaEditor agenda={agenda} onChange={setAgenda} />
          </Campo>

          <Campo rotulo={t('rotinas.revisar.modos')} dica={t('rotinas.revisar.modosDica')}>
            <ModosEditor
              modos={modos}
              onChange={setModos}
              disponiveis={mode === 'chat' ? ROTINA_MODOS_CHAT : undefined}
            />
          </Campo>

          <Campo rotulo={t('rotinas.criar.modelo')}>
            <RotinaModelPicker value={modelo} onChange={setModelo} />
          </Campo>

          {mode === 'code' && (
            <Campo rotulo={t('rotinas.revisar.pastas')} dica={t('rotinas.revisar.pastasDica')}>
              {pastas.length === 0 ? (
                <Text style={[s.dica, { color: tokens.destructive }]}>{t('rotinas.revisar.semPastas')}</Text>
              ) : (
                <View style={{ gap: 4 }}>
                  {pastas.map((pasta) => (
                    <View key={pasta} style={s.pastaRow}>
                      <Folder size={13} color={tokens.mutedForeground} />
                      <Text style={[s.pastaText, { color: tokens.mutedForeground }]} numberOfLines={1}>
                        {pasta}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </Campo>
          )}

          {erro && (
            <View style={[s.erroBox, { borderColor: tokens.destructive }, destaqueErro]}>
              <AlertCircle size={14} color={tokens.destructive} />
              <Text style={[s.erroText, { color: tokens.destructive }]}>{erro}</Text>
            </View>
          )}

          <Pressable
            onPress={() => (rotina ? void handleSalvar() : void handleCriar())}
            disabled={!podeSalvar}
            style={[s.botaoPrincipal, { backgroundColor: tokens.primary }, !podeSalvar && { opacity: 0.4 }]}
          >
            {salvando ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Sparkles size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.botaoTexto, { color: tokens.primaryForeground }]}>
              {salvando
                ? t('rotinas.lista.salvando')
                : rotina
                  ? t('rotinas.lista.salvar')
                  : t('rotinas.revisar.criar')}
            </Text>
          </Pressable>
        </>
      )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: React.ReactNode }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.rotulo, { color: tokens.foreground }]}>{rotulo}</Text>
      {dica && <Text style={[s.dica, { color: tokens.mutedForeground }]}>{dica}</Text>}
      {children}
    </View>
  )
}

const s = StyleSheet.create({
  dica: { fontSize: 12, lineHeight: 17 },
  rotulo: { fontSize: 14, fontWeight: '600' },
  erroBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  erroText: { flex: 1, fontSize: 12 },
  gerandoBox: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  etapa1Row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  modoDica: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  botaoPrincipal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 12,
  },
  botaoTexto: { fontSize: 14, fontWeight: '600' },
  voltarRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  linkText: { fontSize: 13 },
  pastaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pastaText: { fontSize: 12, flex: 1 },
})
