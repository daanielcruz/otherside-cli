import { useContext } from "react";
import StdinContext from "@/terminal-runtime/react/input-stream-context.js";

const useInputStream = () => useContext(StdinContext);
export default useInputStream;
