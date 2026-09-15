# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Mobile x Desktop: feature gaps (rastreado)

## Pendente (fazer)
1. **Filtros do catálogo de modelos** — desktop ModelsView filtra por provider, capacidade, preço, velocidade, contexto
2. **Aba Fontes** — no desktop o usuário declara as fontes da conversa (arquivo, texto colado, site) e elas viram `srcN`/`docN` para o agente. No mobile não há como declarar nem listar: as fontes existem e o agente as usa, mas só dá para gerenciá-las no desktop
3. **Visualizador de documento** — PDF/DOCX/planilha abrem no painel do desktop (com sumário, localizar, zoom, imprimir). No mobile o documento gerado é só anunciado, e a citação `#orbit-source/...` não tem para onde levar

## Concluído
- Rotação de modelos no mobile (tela de rotações + grupo no seletor), sincronizada com o desktop pelo companion (`GET /api/rotations`, WS `rotation:change` / `rotation:select` / `rotation:set`); quem roda a sequência continua sendo o engine do desktop
- FilePart nas mensagens do assistente (`case 'file'` em ChatAssistantMessage.tsx)
- DocumentPart anunciada em vez de virar buraco na mensagem (`case 'document'`) — mesmo tratamento que o artefato já tinha
- Imagem anexada abre o ORIGINAL da galeria ao ampliar, não o thumbnail de 320px da bolha. Depende do desktop reescrever `FilePart.mediaUrl` para HTTP assinado (companion-media.ts): o app não conhece `orbit-media://`
- MCP/Skills CRUD completo no mobile (criar, editar, excluir, importar skills; adicionar, editar, excluir, reconectar servidores MCP)
