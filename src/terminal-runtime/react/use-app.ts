import { useContext } from "react";
import AppContext from "./runtime-context.js";

const useApp = () => useContext(AppContext);
export default useApp;
