import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/**
 * The one card for everything the chat proposes — skill, MCP server, agent.
 * Same anatomy as the desktop's `ProposalCard`
 * (apps/desktop/src/components/proposal-card.tsx): kind + title + state badge,
 * labelled facts, an optional note, and a footer of actions. The difference is
 * only the touch size of the buttons.
 */

export type ProposalBadge = {
  label: string
  tone?: 'muted' | 'success'
}

export type ProposalFact = {
  label: string
  value: string
  /** Targets and slugs read better in monospace, as on the desktop. */
  mono?: boolean
}

type ProposalCardProps = {
  icon: ReactNode
  kind: string
  title: string
  badge?: ProposalBadge
  facts?: ProposalFact[]
  note?: string
  noteTone?: 'muted' | 'destructive' | 'warning'
  children?: ReactNode
  actions?: ReactNode
}

export function ProposalCard({
  icon,
  kind,
  title,
  badge,
  facts,
  note,
  noteTone = 'muted',
  children,
  actions,
}: ProposalCardProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hasBody = Boolean((facts && facts.length > 0) || note || children)

  return (
    <View style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={s.head}>
        <View style={[s.iconBox, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>{icon}</View>
        <View style={s.headText}>
          <Text style={[s.kind, { color: tokens.mutedForeground }]}>{kind}</Text>
          <Text style={[s.title, { color: tokens.foreground }]}>{title}</Text>
        </View>
        {badge ? (
          <View
            style={[
              s.badge,
              {
                borderColor: badge.tone === 'success' ? withAlpha(tokens.success, 0.4) : tokens.border,
              },
            ]}
          >
            <Text style={[s.badgeText, { color: badge.tone === 'success' ? tokens.success : tokens.mutedForeground }]}>
              {badge.label}
            </Text>
          </View>
        ) : null}
      </View>

      {hasBody ? (
        <View style={[s.body, { borderColor: tokens.border }]}>
          {facts?.map((fact) => (
            <View key={fact.label} style={s.fact}>
              <Text style={[s.factLabel, { color: tokens.mutedForeground }]}>{fact.label}</Text>
              <Text
                style={[s.factValue, { color: tokens.foreground }, fact.mono && s.mono]}
                numberOfLines={fact.mono ? 1 : undefined}
              >
                {fact.value}
              </Text>
            </View>
          ))}
          {children}
          {note ? (
            <Text
              style={[
                s.note,
                {
                  color:
                    noteTone === 'destructive'
                      ? tokens.destructive
                      : noteTone === 'warning'
                        ? tokens.warning
                        : tokens.mutedForeground,
                },
              ]}
            >
              {note}
            </Text>
          ) : null}
        </View>
      ) : null}

      {actions ? (
        <View style={[s.footer, { borderColor: tokens.border, backgroundColor: withAlpha(tokens.muted, 0.3) }]}>
          {actions}
        </View>
      ) : null}
    </View>
  )
}

type ProposalActionProps = {
  label: string
  onPress: () => void
  variant?: 'ghost' | 'outline' | 'primary'
  disabled?: boolean
  icon?: ReactNode
}

export function ProposalAction({ label, onPress, variant = 'outline', disabled, icon }: ProposalActionProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const color =
    variant === 'primary' ? tokens.primaryForeground : variant === 'ghost' ? tokens.mutedForeground : tokens.foreground

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.action,
        {
          backgroundColor: variant === 'primary' ? tokens.primary : 'transparent',
          borderColor: variant === 'outline' ? tokens.border : 'transparent',
        },
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon}
      <Text style={[s.actionText, { color }]}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12 },
  iconBox: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, minWidth: 0 },
  kind: { fontSize: 10, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { marginTop: 2, fontSize: 14, fontWeight: '600', letterSpacing: -0.1 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.3 },
  body: { borderTopWidth: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 6 },
  fact: { flexDirection: 'row', gap: 8 },
  factLabel: { width: 82, fontSize: 12, lineHeight: 17 },
  factValue: { flex: 1, fontSize: 12, lineHeight: 17 },
  mono: { fontFamily: MONO_FONT },
  note: { fontSize: 11, lineHeight: 15 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  action: {
    height: 40,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionText: { fontSize: 12, fontWeight: '500' },
})
