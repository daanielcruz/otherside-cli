declare module "react-devtools-core" {
  export function initialize(contentWindow?: unknown): void;
  export function connectToDevTools(options?: {
    host?: string;
    port?: number;
    websocket?: unknown;
    resolveRNStyle?: unknown;
    isAppActive?: () => boolean;
  }): void;
}
