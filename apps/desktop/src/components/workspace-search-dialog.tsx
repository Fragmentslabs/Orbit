import { useWorkspace } from "@/lib/workspace-context";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { WorkspaceSearch } from "@/src/components/workspace-search";
import { useWorkspaceSearchStore } from "@/src/stores/workspace-search-store";

/**
 * A busca do espaço em modal (⌘P).
 *
 * Mora no App, e não na aba de arquivos: o atalho tem de responder de qualquer
 * aba, inclusive com o painel fechado. O que ela NÃO faz aqui é abrir o
 * arquivo — isso é do visualizador, que vive na aba de arquivos. Por isso o
 * resultado vira um pedido no store (`requestFile`) em vez de navegação direta.
 */
export function WorkspaceSearchDialog() {
  const open = useWorkspaceSearchStore((state) => state.open);
  const close = useWorkspaceSearchStore((state) => state.close);
  const requestFile = useWorkspaceSearchStore((state) => state.requestFile);
  const replace = useWorkspaceSearchStore((state) => state.replaceInOpenFile);
  const notifyReplaced = useWorkspaceSearchStore((state) => state.notifyReplaced);
  const { folders } = useWorkspace();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl gap-0 p-0" showCloseButton={false}>
        <WorkspaceSearch
          autoFocus
          className="max-h-[65vh]"
          openFile={replace?.path ?? null}
          roots={folders}
          variant="dialog"
          onOpen={(path, line) => requestFile(path, line)}
          onReplaceInFile={replace?.run}
          onReplaced={notifyReplaced}
        />
      </DialogContent>
    </Dialog>
  );
}
