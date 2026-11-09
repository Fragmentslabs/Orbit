import type { OrchestrationSettings, SendMessageOptions } from '@shared/chat'

type Unattended = NonNullable<NonNullable<SendMessageOptions['orchestrate']>['unattended']>

/**
 * The orchestra settings an unattended run (a routine's team) uses.
 *
 * The global behaviour is a choice made for chats the person is watching; a routine runs while
 * nobody is, and a model reviewing every worker (adjustments, extra workers, project checks)
 * makes its cost and duration unpredictable. So a routine runs as `orchestrate` — no review —
 * unless the routine opted in. Opting in uses the global behaviour, and asks for at least
 * `supervise` when the global one is `orchestrate`, because that is what the person asked for.
 */
export function settingsForUnattended(config: OrchestrationSettings, unattended: Unattended | undefined): OrchestrationSettings {
  if (!unattended) return config
  if (!unattended.review) return { ...config, behavior: 'orchestrate' }
  return config.behavior === 'orchestrate' ? { ...config, behavior: 'supervise' } : config
}
