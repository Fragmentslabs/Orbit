"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranchIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * What the Changes and Commits views show for a folder that is not a git repository: instead of
 * git's own error, a plain sentence and the way out — start a repository there (`git init`).
 */
export function NoGitState({
  folder,
  onStarted,
}: {
  /** The folder to start the repository in. */
  folder: string;
  /** The repository exists now: the host reads the folder again. */
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = (await window.ipcRenderer.invoke("git:init", folder)) as
      | { ok: true }
      | { ok: false; error: string };
    setBusy(false);
    if (result.ok) onStarted();
    else setError(result.error);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <GitBranchIcon className="size-16 text-muted-foreground/20" />
      <div className="space-y-1">
        <p className="text-sm text-foreground">{t("folders.noGit")}</p>
        <p className="text-sm text-muted-foreground">{t("folders.noGitHint")}</p>
      </div>
      <Button size="sm" onClick={() => void start()} disabled={busy}>
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <GitBranchIcon className="size-4" />
        )}
        {t("folders.gitInit")}
      </Button>
      {error && <p className="max-w-xs text-sm text-destructive">{error}</p>}
    </div>
  );
}
