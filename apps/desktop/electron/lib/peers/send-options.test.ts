import { describe, expect, it } from 'vitest'
import type { SendMessageRequest } from '@shared/companion'
import { cleanControlSend, cleanSendOptions } from './send-options'

const base = (extra: Partial<SendMessageRequest> = {}): SendMessageRequest => ({ type: 'messages:send', sessionId: 's1', text: 'hi', ...extra })
const png = { id: 'f', type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,AAAA' }

describe('cleanControlSend', () => {
  it('keeps what the phone sends: model, modes, thinking, permission, files, delegated models, folders', () => {
    const out = cleanControlSend(
      base({
        providerId: 'anthropic',
        modelId: 'opus',
        options: { research: true, brain: false, reasoning: { enabled: true, variantId: 'high' }, permissionMode: 'approve' },
        files: [png],
        workerModel: { providerId: 'w', modelId: 'm' },
        visionModel: { providerId: 'v', modelId: 'm' },
        loopConfig: { maxIterations: 3 },
        directory: '/work/app',
      }),
    )
    expect(out).toMatchObject({
      providerId: 'anthropic',
      modelId: 'opus',
      options: { research: true, brain: false, reasoning: { enabled: true, variantId: 'high' }, permissionMode: 'approve' },
      files: [png],
      workerModel: { providerId: 'w' },
      visionModel: { providerId: 'v' },
      loopConfig: { maxIterations: 3 },
      directory: '/work/app',
    })
  })

  it('drops the options only this machine sets, and malformed values', () => {
    const options = cleanSendOptions({ computer: true, profile: 'x', overlay: true, voiceCall: true, planReview: {}, orchestrate: {}, permissionMode: 'root', brain: 'yes', plan: true })
    expect(options).toEqual({ plan: true })
  })

  it('needs a chat and something to say (text or a file)', () => {
    expect(cleanControlSend(base({ text: '  ' }))).toBeNull()
    expect(cleanControlSend(base({ sessionId: '' }))).toBeNull()
    expect(cleanControlSend(base({ text: '', files: [png] }))).not.toBeNull()
  })

  it('does not forward a model half, non-data attachments, a relative folder or an absurd loop', () => {
    const out = cleanControlSend(
      base({
        providerId: 'anthropic',
        files: [{ ...png, url: 'file:///etc/passwd' }],
        directory: 'relative',
        loopConfig: { maxIterations: 9999 },
      }),
    )
    expect(out).not.toHaveProperty('providerId')
    expect(out).not.toHaveProperty('files')
    expect(out).not.toHaveProperty('directory')
    expect(out).not.toHaveProperty('loopConfig')
  })
})
