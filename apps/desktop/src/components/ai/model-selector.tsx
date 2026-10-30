"use client"

import { useTranslation } from "react-i18next"
import type { ComponentProps, ReactNode } from "react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useState } from "react"
import { Button } from "@/components/ui/button"

export type ModelSelectorProps = ComponentProps<typeof Dialog>

export const ModelSelector = (props: ModelSelectorProps) => <Dialog {...props} />

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DialogTrigger {...props} />
)

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode
}

export const ModelSelectorContent = ({
  className,
  children,
  title,
  ...props
}: ModelSelectorContentProps) => {
  const { t } = useTranslation()
  return (
    <DialogContent
      className={cn(
        "p-0 sm:max-w-sm",
        // The dialog is `p-0` with an `sr-only` title, so the first visible
        // line is the search bar — and the close button (absolute,
        // `top-2 right-2`, size-6) was drawn OVER the field. Here the
        // input wrapper leaves room on the right (36px = 8px of the button +
        // 24px of width + 4px of breathing room) so the two stay side by
        // side. Vertically, the field goes from 8px to 40px (p-1 of Command +
        // p-1 of the wrapper + `h-8` of InputGroup), centered at 24px. The
        // dialog's `top-2` left the button at 8..32 (center at 20px) —
        // 4px above the field; `top-3` puts it at 12..36, on the same central
        // axis of the field.
        "[&_[data-slot=command-input-wrapper]]:pr-9",
        "[&_[data-slot=dialog-close]]:top-3",
        className,
      )}
      {...props}
    >
      <DialogTitle className="sr-only">{title ?? t("modelPicker.title")}</DialogTitle>
      <Command className="**:data-[slot=command-input-wrapper]:h-auto">{children}</Command>
    </DialogContent>
  )
}

export type ModelSelectorDialogProps = ComponentProps<typeof CommandDialog>

export const ModelSelectorDialog = (props: ModelSelectorDialogProps) => <CommandDialog {...props} />

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>

export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-3.5", className)} {...props} />
)

export type ModelSelectorListProps = ComponentProps<typeof CommandList>

// The search wrapper has no padding at the bottom (`pb-0`); what gave the breathing room
// was the header of the first group. A loose item at the top ("Same as the
// conversation", "None") touched the field — the space goes in the list.
export const ModelSelectorList = ({ className, ...props }: ModelSelectorListProps) => (
  <CommandList className={cn("pt-2", className)} {...props} />
)

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => <CommandEmpty {...props} />

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>

export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => <CommandGroup {...props} />

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>

export const ModelSelectorItem = (props: ModelSelectorItemProps) => <CommandItem {...props} />

export type ModelSelectorShortcutProps = ComponentProps<typeof CommandShortcut>

export const ModelSelectorShortcut = (props: ModelSelectorShortcutProps) => (
  <CommandShortcut {...props} />
)

export type ModelSelectorSeparatorProps = ComponentProps<typeof CommandSeparator>

export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
)

export type ModelSelectorLogoProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  provider:
    | "moonshotai-cn"
    | "lucidquery"
    | "moonshotai"
    | "zai-coding-plan"
    | "alibaba"
    | "xai"
    | "vultr"
    | "nvidia"
    | "upstage"
    | "groq"
    | "github-copilot"
    | "mistral"
    | "vercel"
    | "nebius"
    | "deepseek"
    | "alibaba-cn"
    | "google-vertex-anthropic"
    | "venice"
    | "chutes"
    | "cortecs"
    | "github-models"
    | "togetherai"
    | "azure"
    | "baseten"
    | "huggingface"
    | "opencode"
    | "fastrouter"
    | "google"
    | "google-vertex"
    | "cloudflare-workers-ai"
    | "inception"
    | "wandb"
    | "openai"
    | "zhipuai-coding-plan"
    | "perplexity"
    | "openrouter"
    | "zenmux"
    | "v0"
    | "iflowcn"
    | "synthetic"
    | "deepinfra"
    | "zhipuai"
    | "submodel"
    | "zai"
    | "inference"
    | "requesty"
    | "morph"
    | "lmstudio"
    | "anthropic"
    | "aihubmix"
    | "fireworks-ai"
    | "modelscope"
    | "llama"
    | "scaleway"
    | "amazon-bedrock"
    | "cerebras"
    // Keeps the autocomplete of the literals above without closing the union: any
    // new provider of the catalog stays valid. `Record<never, never>` is the
    // equivalent of `{}` that does not fall into ban-types.
    | (string & Record<never, never>)
}

export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 dark:invert", className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
)

export type ModelSelectorLogoGroupProps = ComponentProps<"div">

export const ModelSelectorLogoGroup = ({ className, ...props }: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      "-space-x-1 flex shrink-0 items-center [&>img]:rounded-full [&>img]:bg-background [&>img]:p-px [&>img]:ring-1 dark:[&>img]:bg-foreground",
      className,
    )}
    {...props}
  />
)

export type ModelSelectorNameProps = ComponentProps<"span">

export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn("flex-1 truncate text-left", className)} {...props} />
)

const models = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    chef: "OpenAI",
    chefSlug: "openai",
    providers: ["openai", "azure"],
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    chef: "OpenAI",
    chefSlug: "openai",
    providers: ["openai"],
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet",
    chef: "Anthropic",
    chefSlug: "anthropic",
    providers: ["anthropic"],
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    chef: "Google",
    chefSlug: "google",
    providers: ["google"],
  },
]

export default function ModelSelectorDemo() {
  const [open, setOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>("gpt-4o")

  const selectedModelData = models.find(model => model.id === selectedModel)
  const chefs = Array.from(new Set(models.map(model => model.chef)))

  return (
    <div className="flex size-full items-center justify-center p-8">
      <ModelSelector onOpenChange={setOpen} open={open}>
        <ModelSelectorTrigger render={<Button className="w-[200px] justify-between" variant="outline" />}>
          {selectedModelData?.chefSlug && (
            <ModelSelectorLogo provider={selectedModelData.chefSlug} />
          )}
          {selectedModelData?.name && (
            <ModelSelectorName>{selectedModelData.name}</ModelSelectorName>
          )}
        </ModelSelectorTrigger>
        <ModelSelectorContent>
          <ModelSelectorInput placeholder="Search models..." />
          <ModelSelectorList>
            <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
            {chefs.map(chef => (
              <ModelSelectorGroup heading={chef} key={chef}>
                {models
                  .filter(model => model.chef === chef)
                  .map(model => (
                    <ModelSelectorItem
                      key={model.id}
                      onSelect={() => {
                        setSelectedModel(model.id)
                        setOpen(false)
                      }}
                      value={model.id}
                      className={selectedModel === model.id ? "bg-primary/10" : undefined}
                    >
                      <ModelSelectorLogo provider={model.chefSlug} />
                      <ModelSelectorName>{model.name}</ModelSelectorName>
                      <ModelSelectorLogoGroup>
                        {model.providers.map(provider => (
                          <ModelSelectorLogo key={provider} provider={provider} />
                        ))}
                      </ModelSelectorLogoGroup>
                    </ModelSelectorItem>
                  ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    </div>
  )
}
