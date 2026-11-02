import { describe, expect, it, vi } from 'vitest'
import type { AskItem } from '@shared/chat'

vi.mock('./ask-broker', () => ({ reply: vi.fn() }))
vi.mock('./app-language', () => ({ readAppLanguage: async () => 'English' }))
vi.mock('./i18n', () => ({ t: async (key: string) => key }))
vi.mock('./auth', () => ({ listCredentialProviders: async () => [] }))
vi.mock('./broadcast', () => ({ broadcastChatEvent: vi.fn() }))
vi.mock('./chat-engine', () => ({ runChat: vi.fn() }))
vi.mock('./subchats', () => ({ createContinuationRecord: vi.fn(), createSubchatRecord: vi.fn() }))
vi.mock('./subchat-wake', () => ({ wakeParentOf: vi.fn() }))
vi.mock('./storage', () => ({ listKeys: async () => [], readJson: async () => null, removeJson: vi.fn(), writeJson: vi.fn() }))

const { responseBlock } = await import('./ask-resume')

const texts = { authorize: 'I authorize the action', noAnswer: '(no answer)', subchatHere: "I'd rather do this in this conversation, not in another chat." }
const card = {
  requestId: 'req_1',
  kind: 'subchat',
  subchat: { title: 'CSV parser', brief: 'Fix the quote split in csv-parser.ts:42.', scope: 'subchat' },
} as AskItem

describe('responseBlock — subchat card answered after its turn died', () => {
  it('"here" restates the task, so the agent knows what to do here', () => {
    expect(responseBlock(card, 'here', texts)).toBe(
      `${texts.subchatHere}\n\nCSV parser — Fix the quote split in csv-parser.ts:42.`,
    )
  })

  it('declining tells the agent nothing', () => {
    expect(responseBlock(card, 'deny', texts)).toBeNull()
  })
})
