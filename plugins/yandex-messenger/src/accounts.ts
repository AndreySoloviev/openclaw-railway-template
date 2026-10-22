import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { CHANNEL_ID } from "./policy.js";

export const TOKEN_ENV_VAR = "YANDEX_MESSENGER_TOKEN";

export type YandexAccountConfig = {
  enabled?: boolean;
  name?: string;
  token?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  dmDenyText?: string;
  dmDenyIntervalHours?: number;
  pollIntervalMs?: number;
  mediaMaxMb?: number;
};

export type ResolvedYandexAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "config" | "env" | "none";
  config: YandexAccountConfig;
};

function readSection(cfg: OpenClawConfig): YandexAccountConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] ??
    {}) as YandexAccountConfig;
}

export function listAccountIds(): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedYandexAccount {
  const config = readSection(params.cfg);
  const configToken = typeof config.token === "string" ? config.token.trim() : "";
  const envToken = process.env[TOKEN_ENV_VAR]?.trim() ?? "";
  const token = configToken || envToken;
  return {
    accountId: params.accountId?.trim() || DEFAULT_ACCOUNT_ID,
    name: config.name,
    enabled: config.enabled !== false,
    token,
    tokenSource: configToken ? "config" : envToken ? "env" : "none",
    config,
  };
}

export function isAccountConfigured(account: ResolvedYandexAccount): boolean {
  return Boolean(account.token);
}

export function inspectAccount(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const account = resolveAccount(params);
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isAccountConfigured(account),
    tokenSource: account.tokenSource,
    tokenStatus: account.token ? "available" : "missing",
    mode: "polling",
    dmPolicy: account.config.dmPolicy ?? "allowlist",
  };
}
