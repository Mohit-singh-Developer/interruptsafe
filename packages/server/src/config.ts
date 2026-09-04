import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MockToolMode } from "./tools/tool";

/**
 * Environment configuration, parsed and validated once at startup.
 *
 * Secrets are read here and never logged. The server fails fast with a clear
 * message rather than starting in a half-configured state - in particular, it
 * never silently falls back from a requested real provider to the mock.
 *
 * The `.env` file is loaded by Node's own `process.loadEnvFile`, so no dotenv
 * dependency is required.
 */

/**
 * Loads the repository-root `.env` if it exists.
 *
 * Node applies file values only where a variable is not already set, so real
 * environment variables always take precedence. A missing file is not an
 * error - deterministic mode needs no configuration at all - but a malformed
 * one still surfaces.
 */
export function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src
  const envPath = resolve(here, "../../../.env"); // repository root

  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export type ProviderKind = "deterministic" | "anthropic";

const PROVIDER_KINDS: readonly ProviderKind[] = ["deterministic", "anthropic"];

export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly LlmEffort[] = ["low", "medium", "high", "xhigh", "max"];

const MOCK_TOOL_MODES: readonly MockToolMode[] = ["cooperative", "stubborn"];

/** Matches the documented value in .env.example. */
const DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly effort: LlmEffort;
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly provider: ProviderKind;
  /** Present only when `provider` is "anthropic". */
  readonly anthropic?: AnthropicConfig;
  /**
   * Artificial latency for the deterministic mock, in milliseconds.
   *
   * DEVELOPMENT AID ONLY, default 0. The mock replies instantly, which leaves
   * no window to press Interrupt by hand; this opens one for demos. It has no
   * effect on the real provider and is not part of the correctness model.
   */
  readonly deterministicDelayMs: number;
  /**
   * Artificial latency for the MOCK tools, in milliseconds.
   *
   * DEVELOPMENT AID ONLY, default 0. Mock tools return instantly otherwise,
   * leaving no window in which to interrupt one mid-run.
   */
  readonly mockToolDelayMs: number;
  /**
   * How MOCK tools react to an abort request.
   *
   * `cooperative` (default) stops early; `stubborn` ignores the signal and
   * returns anyway. Both must produce a correct outcome - the setting exists to
   * demonstrate that fencing, not cancellation, is what makes it correct.
   */
  readonly mockToolMode: MockToolMode;
}

/** Thrown when configuration is missing or invalid. Message is safe to print. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function readProviderKind(): ProviderKind {
  const raw = (process.env.LLM_PROVIDER ?? "deterministic").trim().toLowerCase();

  if (!PROVIDER_KINDS.includes(raw as ProviderKind)) {
    throw new ConfigError(
      `LLM_PROVIDER must be one of: ${PROVIDER_KINDS.join(", ")}. Received "${raw}".`,
    );
  }

  return raw as ProviderKind;
}

function readAnthropicConfig(): AnthropicConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

  if (apiKey.length === 0) {
    throw new ConfigError(
      'LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set. ' +
        "Set it in .env (copy .env.example), or select the mock provider with " +
        "LLM_PROVIDER=deterministic.",
    );
  }

  // The model has a documented default, so it is optional; the API key is not,
  // because there is no safe value to assume.
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;

  const effortRaw = (process.env.LLM_EFFORT ?? "low").trim().toLowerCase();
  if (!EFFORTS.includes(effortRaw as LlmEffort)) {
    throw new ConfigError(
      `LLM_EFFORT must be one of: ${EFFORTS.join(", ")}. Received "${effortRaw}".`,
    );
  }

  return { apiKey, model, effort: effortRaw as LlmEffort };
}

/** Shared validation for the development delay knobs. */
function readDelayMs(variable: string): number {
  const raw = process.env[variable]?.trim();
  if (raw === undefined || raw.length === 0) return 0;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(
      `${variable} must be a non-negative whole number of milliseconds. Received "${raw}".`,
    );
  }
  return parsed;
}

function readMockToolMode(): MockToolMode {
  const raw = (process.env.DEV_MOCK_TOOL_MODE ?? "cooperative").trim().toLowerCase();

  if (!MOCK_TOOL_MODES.includes(raw as MockToolMode)) {
    throw new ConfigError(
      `DEV_MOCK_TOOL_MODE must be one of: ${MOCK_TOOL_MODES.join(", ")}. Received "${raw}".`,
    );
  }

  return raw as MockToolMode;
}

export function loadConfig(): Config {
  const provider = readProviderKind();

  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
    logLevel: process.env.LOG_LEVEL ?? "info",
    provider,
    ...(provider === "anthropic" ? { anthropic: readAnthropicConfig() } : {}),
    deterministicDelayMs: readDelayMs("DEV_DETERMINISTIC_DELAY_MS"),
    mockToolDelayMs: readDelayMs("DEV_MOCK_TOOL_DELAY_MS"),
    mockToolMode: readMockToolMode(),
  };
}
