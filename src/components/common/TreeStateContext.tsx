import { createContext, useEffect, useRef } from "react";
import { registerLiveTree } from "@/state/store/liveTrees";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import type { TreeState } from "@/utils/treeReducer";

export const TreeStateContext = createContext<TreeStore | null>(null);

export function TreeStateProvider({
  id,
  initial,
  children,
}: {
  id?: string;
  initial?: TreeState;
  children: React.ReactNode;
}) {
  const store = useRef(createTreeStore(id, initial)).current;
  // Known by id, so a file changed elsewhere (sync, undo) can be reloaded in place.
  useEffect(() => (id ? registerLiveTree(id, store) : undefined), [id, store]);

  return <TreeStateContext.Provider value={store}>{children}</TreeStateContext.Provider>;
}
