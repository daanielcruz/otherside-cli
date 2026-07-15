import type { Key, ReactNode, Ref } from "react";
import type { Except } from "type-fest";
import type { Styles } from "@/terminal-runtime/paint/style-model.ts";
import type { TreeElement } from "@/terminal-runtime/tree/elements.ts";

declare module "react/compiler-runtime" {
  export function c(slotCount: number): unknown[];
}

declare module "react-reconciler" {
  interface Reconciler<C, I, TI, PI, P, R> {
    discreteUpdates<A extends unknown[]>(fn: (...args: A) => void, ...args: A): void;
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ink-root": Ink.Box;
      "ink-box": Ink.Box;
      "ink-text": Ink.Text;
      "ink-virtual-text": Ink.Text;
      "ink-link": Ink.Link;
      "ink-progress": Ink.Progress;
      "ink-raw-ansi": Ink.RawAnsi;
    }
  }
}

declare namespace Ink {
  type Box = {
    internal_static?: boolean | undefined;
    children?: ReactNode;
    key?: Key | undefined;
    ref?: Ref<TreeElement> | undefined;
    style?: Except<Styles, "textWrap"> | undefined;
    internal_accessibility?: TreeElement["internal_accessibility"] | undefined;
  };

  type Text = {
    children?: ReactNode;
    key?: Key;
    style?: Styles;
    textStyles?: unknown;
    accessibility?: TreeElement["internal_accessibility"] | undefined;

    internal_transform?: (children: string, index: number) => string;
    internal_accessibility?: TreeElement["internal_accessibility"];
  };

  type Link = {
    children?: ReactNode;
    key?: Key;
    href: string;
  };

  type RawAnsi = {
    key?: Key;
    rawText: string;
    rawWidth: number;
    rawHeight: number;
  };

  type Progress = {
    children?: ReactNode;
    key?: Key;
    style?: Styles;
    value?: number;
  };
}
