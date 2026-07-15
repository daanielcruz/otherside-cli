import { createContext, type ReactNode } from "react";

export type StaticFlushEnqueuer = (node: ReactNode) => void;

const StaticFlushContext = createContext<StaticFlushEnqueuer>(() => {});

StaticFlushContext.displayName = "InternalStaticFlushContext";

export default StaticFlushContext;
