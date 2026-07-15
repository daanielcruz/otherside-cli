import { createContext, useContext } from "react";

export const ModalReducedContext = createContext<boolean>(false);

export function useIsInsideModal(): boolean {
  return useContext(ModalReducedContext);
}
