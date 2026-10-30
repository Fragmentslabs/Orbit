import { useWorkspace } from "@/lib/workspace-context";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { WorkspaceSearch } from "@/src/components/workspace-search";
import { useWorkspaceSearchStore } from "@/src/stores/workspace-search-store";

/**
 * The workspace search in a modal (⌘P).
 *
 * It lives in the App, and not in the files tab: the shortcut has to answer from any
 * tab, including with the panel closed. What it does NOT do here is open the
 * file — that belongs to the viewer, which lives in the files tab. That is why the
 * result becomes a request in the store (`requestFile`) instead of direct navigation.
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
