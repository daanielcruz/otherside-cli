import { useEffect, useLayoutEffect } from "react";
import { useEventCallback } from "usehooks-ts";
import type { KeyStroke, TerminalKey } from "@/terminal-runtime/input/input-signal.js";
import useInputStream from "@/terminal-runtime/react/use-input-stream.js";

type InputEventListener = (input: string, key: TerminalKey, event: KeyStroke) => void;

type Options = {
  isActive?: boolean;
};

const useKeyEvents = (inputHandler: InputEventListener, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useInputStream();

  useLayoutEffect(() => {
    if (options.isActive === false) {
      return;
    }

    setRawMode(true);

    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);

  const handleData = useEventCallback((event: KeyStroke) => {
    if (options.isActive === false) {
      return;
    }
    const { input, key } = event;

    if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event);
    }
  });

  useEffect(() => {
    internal_eventEmitter?.on("input", handleData);

    return () => {
      internal_eventEmitter?.removeListener("input", handleData);
    };
  }, [internal_eventEmitter, handleData]);
};

export default useKeyEvents;
