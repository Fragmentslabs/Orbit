/**
 * Shared by every tool that PROPOSES something the person confirms in a card (routine, agent,
 * skill, hook, MCP server). Creation starts in a chat with a half-written sentence, so the
 * request is often vague; asking beats guessing, but only about what the proposal really
 * depends on — a conversation of questions is its own kind of annoying.
 */
export const ASK_WHEN_VAGUE =
  'If the request is vague or leaves out something this proposal depends on, ask the person first with the question tool: two or three short questions at most, offering the likely answers. ' +
  'Do not ask about what you can choose sensibly — choose it and say so in the card. If you really cannot tell what they want, say that you did not understand and what you need.'
