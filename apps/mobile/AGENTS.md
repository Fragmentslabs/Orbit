# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Mobile x Desktop: feature gaps (rastreado)

## Pendente (fazer)
1. **Filtros do catálogo de modelos** — desktop ModelsView filtra por provider, capacidade, preço, velocidade, contexto

## Concluído
- Rotação de modelos no mobile (tela de rotações + grupo no seletor), sincronizada com o desktop pelo companion (`GET /api/rotations`, WS `rotation:change` / `rotation:select` / `rotation:set`); quem roda a sequência continua sendo o engine do desktop
- FilePart nas mensagens do assistente (`case 'file'` em ChatAssistantMessage.tsx)
- MCP/Skills CRUD completo no mobile (criar, editar, excluir, importar skills; adicionar, editar, excluir, reconectar servidores MCP)
