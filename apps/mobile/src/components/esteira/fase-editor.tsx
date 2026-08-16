/**
 * Editor de fase — paridade total com o FaseEditor do desktop: nome,
 * descrição, papel, prompt e capacidades; "salvar como padrão" grava o
 * template mestre (só para fases com templateId — custom não tem mestre).
 *
 * Montado condicionalmente pelo pai (com key por fase): o estado inicial vem
 * direto dos props, sem efeito de reset. Bottom sheet (Modal nativo), imune
 * aos problemas de posicionamento do Dialog.
 */
import { useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { FaseEscolhida, FaseTipo, ToolPermitida } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const TIPOS: FaseTipo[] = ['desenvolvimento', 'validacao', 'seguranca', 'revisao', 'infra', 'generico']
const CAPACIDADES: ToolPermitida[] = ['leitura', 'edit', 'shell', 'browser', 'memoria']

export function FaseEditor({
  onFechar,
  fase,
  onSalvar,
}: {
  onFechar: () => void
  /** Fase em edição — null = fase nova (do zero). */
  fase: FaseEscolhida | null
  onSalvar: (fase: FaseEscolhida, comoPadrao: boolean) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  // Estado inicial dos props: o pai monta com key por fase, então trocar de
  // fase (ou abrir para nova) remonta e zera tudo.
  const [nome, setNome] = useState(fase?.nome ?? '')
  const [descricao, setDescricao] = useState(fase?.descricao ?? '')
  const [tipo, setTipo] = useState<FaseTipo>(fase?.tipo ?? 'generico')
  const [prompt, setPrompt] = useState(fase?.prompt ?? '')
  const [tools, setTools] = useState<ToolPermitida[]>(fase ? [...fase.tools] : ['leitura'])
  const [salvando, setSalvando] = useState(false)

  const podeSalvarPadrao = !!fase?.templateId
  const valido = nome.trim().length > 0 && prompt.trim().length > 0

  const alternarCapacidade = (tool: ToolPermitida) => {
    setTools((atual) => (atual.includes(tool) ? atual.filter((x) => x !== tool) : [...atual, tool]))
  }

  const salvar = async (comoPadrao: boolean) => {
    if (!valido || salvando) return
    setSalvando(true)
    try {
      await onSalvar(
        { templateId: fase?.templateId, nome: nome.trim(), descricao: descricao.trim(), prompt: prompt.trim(), tools, tipo },
        comoPadrao,
      )
    } finally {
      setSalvando(false)
    }
  }

  return (
    <BottomSheet
      aberto
      aoFechar={onFechar}
      // Editor com conteúdo não salvo: fechar só pelos botões, nunca por
      // toque no fundo nem pelo voltar do Android.
      fecharAoToqueFora={false}
      alturaMaxima="92%"
      titulo={
        <Text style={[s.titulo, { color: tokens.foreground }]}>
          {fase ? t('esteira.editarFase') : t('esteira.novaFase')}
        </Text>
      }
    >
      <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled">
        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.faseNome')}</Text>
          <Input value={nome} onChangeText={setNome} placeholder={t('esteira.faseNome')} />
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.faseDescricao')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.faseDescricaoDica')}</Text>
          <Input value={descricao} onChangeText={setDescricao} placeholder={t('esteira.faseDescricaoDica')} />
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.faseTipo')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.faseTipoDica')}</Text>
          <Select
            value={{ value: tipo, label: t(`esteira.tipo.${tipo}`) }}
            onValueChange={(opt) => opt && setTipo(opt.value as FaseTipo)}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('esteira.faseTipo')} />
            </SelectTrigger>
            <SelectContent>
              {TIPOS.map((opcao) => (
                <SelectItem key={opcao} label={t(`esteira.tipo.${opcao}`)} value={opcao} />
              ))}
            </SelectContent>
          </Select>
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.fasePrompt')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.fasePromptDica')}</Text>
          <Textarea
            value={prompt}
            onChangeText={setPrompt}
            placeholder={t('esteira.fasePromptDica')}
            style={{ minHeight: 180, maxHeight: 300, fontFamily: 'monospace' }}
          />
        </View>

        <View style={s.campo}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.faseCapacidades')}</Text>
          <View style={s.chips}>
            {CAPACIDADES.map((tool) => {
              const ativa = tools.includes(tool)
              return (
                <Pressable
                  key={tool}
                  onPress={() => alternarCapacidade(tool)}
                  style={[
                    s.chip,
                    {
                      backgroundColor: ativa ? tokens.primary : tokens.muted,
                      borderColor: ativa ? tokens.primary : tokens.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      s.chipTexto,
                      { color: ativa ? tokens.primaryForeground : tokens.mutedForeground },
                    ]}
                  >
                    {t(`esteira.capacidade.${tool}`)}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      </ScrollView>

      <View style={s.rodape}>
        <Pressable onPress={onFechar} style={s.botaoSecundario}>
          <Text style={[s.botaoSecundarioTexto, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
        </Pressable>
        {podeSalvarPadrao && (
          <Pressable
            onPress={() => void salvar(true)}
            disabled={!valido || salvando}
            style={[s.botaoSecundario, { borderColor: tokens.border }]}
          >
            <Text style={[s.botaoSecundarioTexto, { color: tokens.foreground }]}>
              {t('esteira.salvarComoPadrao')}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => void salvar(false)}
          disabled={!valido || salvando}
          style={[s.botaoPrimario, { backgroundColor: tokens.primary, opacity: valido && !salvando ? 1 : 0.4 }]}
        >
          <Text style={[s.botaoPrimarioTexto, { color: tokens.primaryForeground }]}>
            {t('esteira.salvarNestaEsteira')}
          </Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  titulo: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
  campo: { gap: 5, marginBottom: 14 },
  rotulo: { fontSize: 12, fontWeight: '600' },
  dica: { fontSize: 11, lineHeight: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  chipTexto: { fontSize: 11, fontWeight: '500' },
  rodape: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  botaoSecundario: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  botaoSecundarioTexto: { fontSize: 13, fontWeight: '500' },
  botaoPrimario: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  botaoPrimarioTexto: { fontSize: 13, fontWeight: '600' },
})
