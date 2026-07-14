"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  Link,
  BookIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, memo, useContext, useMemo } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

interface SourcesContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const SourcesContext = createContext<SourcesContextValue | null>(null);

const useSources = () => {
  const context = useContext(SourcesContext);
  if (!context) {
    throw new Error("Sources components must be used within Sources");
  }
  return context;
};

export type SourcesProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const Sources = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: SourcesProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const sourcesContext = useMemo(
      () => ({ isOpen, setIsOpen }),
      [isOpen, setIsOpen],
    );

    return (
      <SourcesContext.Provider value={sourcesContext}>
        <div className={cn("not-prose mb-4", className)} {...props}>
          {children}
        </div>
      </SourcesContext.Provider>
    );
  },
);

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
};

export const SourcesTrigger = memo(
  ({ className, count, children, ...props }: SourcesTriggerProps) => {
    const { isOpen, setIsOpen } = useSources();

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            "flex items-center gap-2 text-primary/80 text-xs transition-colors hover:text-primary",
            className,
          )}
          {...props}
        >
          {children ?? (
            <>
              <p className="font-medium">
                {count} {count === 1 ? "fonte consultada" : "fontes consultadas"}
              </p>
              {isOpen ? (
                <ChevronDownIcon className="size-4 transition-transform" />
              ) : (
                <ChevronRightIcon className="size-4 transition-transform" />
              )}
            </>
          )}
        </CollapsibleTrigger>
      </Collapsible>
    );
  },
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = memo(
  ({ className, ...props }: SourcesContentProps) => {
    const { isOpen } = useSources();

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "mt-3 flex w-fit flex-col gap-2 rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground shadow-md transition-all data-[state=closed]:animate-out data-[state=open]:animate-in",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
            className,
          )}
          {...props}
        />
      </Collapsible>
    );
  },
);

export type SourceProps = Omit<ComponentProps<"a">, "children"> & {
  children?: React.ReactNode;
};

export const Source = memo(
  ({ href, title, children, ...props }: SourceProps) => (
    <a href={href} rel="noreferrer" target="_blank" {...props}>
      {children ?? (
        <span className="group/link inline font-medium hover:text-foreground">
          <BookIcon className="inline shrink-0 h-4 w-4 mr-2" />
          <span>{title}</span>
          <Link
            size={10}
            className="ml-1 inline shrink-0 text-primary/70 group-hover/link:text-primary"
          />
        </span>
      )}
    </a>
  ),
);

Sources.displayName = "Sources";
SourcesTrigger.displayName = "SourcesTrigger";
SourcesContent.displayName = "SourcesContent";
Source.displayName = "Source";

/** Demo component for preview */
export default function SourcesDemo() {
  const sources = [
    { href: "https://stripe.com/docs/api", title: "Stripe API Documentation" },
    { href: "https://docs.github.com/en/rest", title: "GitHub REST API" },
    {
      href: "https://docs.aws.amazon.com/sdk-for-javascript/",
      title: "AWS SDK for JavaScript",
    },
  ];

  return (
    <div className="p-6" style={{ height: "150px" }}>
      <Sources>
        <SourcesTrigger count={sources.length} />
        <SourcesContent>
          {sources.map((source) => (
            <Source href={source.href} key={source.href} title={source.title} />
          ))}
        </SourcesContent>
      </Sources>
    </div>
  );
}
