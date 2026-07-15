import { useContext } from "react";
import AppContext from "@/terminal-runtime/react/runtime-context.js";

const useApp = () => useContext(AppContext);
export default useApp;
