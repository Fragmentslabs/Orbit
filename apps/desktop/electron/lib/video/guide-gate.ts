/**
 * Has this conversation read a video guide topic?
 *
 * The motion contract (everything moves from seek(frame), what is built into
 * window.orbitMotion, how the lint reads) lives in `video_guide("motion")`, and the model that
 * skips it rewrites helpers by hand and trips the lint. motion_write asks for it once, when it
 * is about to CREATE a piece. In memory and per conversation: after a restart it is asked once
 * more, which costs one call and never blocks anything for good.
 */

const read = new Map<string, Set<string>>()

export function markGuideRead(sessionId: string, topic: string): void {
  const topics = read.get(sessionId) ?? new Set<string>()
  topics.add(topic)
  read.set(sessionId, topics)
}

export function hasReadGuide(sessionId: string, topic: string): boolean {
  return read.get(sessionId)?.has(topic) ?? false
}

/** What motion_write answers when a new piece is started without the guide. */
export const GUIDE_FIRST =
  'Before the FIRST composition of this conversation, read the contract: call video_guide("motion") (what is built into window.orbitMotion, scenes, word times, the lint) and video_guide("motion-craft") (shot list, easing, layers, sound), then call motion_write again. Nothing was written. (Editing a piece that already exists does not need this.)'
