export interface AuthCredentials {
  kind: "oauth" | "api_key";
  expiresAt?: number;
  raw: unknown;
}

export interface AuthStrategy {
  load(): Promise<AuthCredentials | null>;
  refresh(creds: AuthCredentials): Promise<AuthCredentials>;
  isExpired(creds: AuthCredentials): boolean;
}
