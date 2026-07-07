import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/lib/workspace-context"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { Persona, type PersonaState } from "@/src/components/ai/persona"

const personaStates: { key: PersonaState; label: string }[] = [
  { key: "idle", label: "Parado" },
  { key: "thinking", label: "Pensando" },
  { key: "listening", label: "Ouvindo" },
  { key: "speaking", label: "Falando" },
  { key: "asleep", label: "Dormindo" },
]

const chatContent = {
  title: "Pronto para conversar",
  subtitle: "Selecione um chat ou inicie uma nova conversa",
  input: <ChatInput />,
}

const codeContent = {
  title: "Pronto para programar",
  subtitle: "Selecione um contexto de código ou inicie um novo",
  input: <CodeInput />,
}

export function ChatView() {
  const { mode } = useWorkspace()
  const [personaState, setPersonaState] = useState<PersonaState>("idle")
  const content = mode === "chat" ? chatContent : codeContent

  return (
    <>
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-6">
          <Persona state={personaState} />
          <div className="flex flex-col items-center gap-2">
            <p className="text-lg font-medium text-foreground">{content.title}</p>
            <p className="text-sm text-muted-foreground">{content.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {personaStates.map(({ key, label }) => (
              <Button
                key={key}
                onClick={() => setPersonaState(key)}
                variant={personaState === key ? "default" : "outline"}
                size="sm"
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {content.input}
    </>
  )
}
