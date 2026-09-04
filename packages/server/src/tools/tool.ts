/**
 * The tool interface.
 *
 * A tool is a unit of slow background work. It knows how to do its job and
 * nothing else: it does not know which generation it belongs to, it cannot
 * reach `ConversationState`, and it has no way to commit anything.
 *
 * That ignorance is deliberate. If a tool could write to the conversation it
 * would be a second door into it, and the guarantee that only current work
 * commits would depend on every tool author remembering to check. Instead a
 * tool returns a value, and `tools/dispatch.ts` decides whether that value is
 * still allowed to matter.
 *
 * `signal` is **advisory**, exactly as it is for providers. A tool may watch it
 * and stop early, or ignore it entirely and return a complete result long after
 * the user has moved on. Both are legitimate; the second is the case this
 * project exists to handle correctly.
 */

export interface ToolInput {
  /** Free-text arguments extracted from the user's message. */
  readonly [key: string]: string | undefined;
}

export interface ToolResult {
  /** Short summary suitable for showing to a person or a model. */
  readonly summary: string;
  /** Deterministic synthetic rows. Never real data. */
  readonly rows: readonly string[];
}

export interface Tool {
  readonly name: string;
  /** One line describing what the tool pretends to do. */
  readonly description: string;
  execute(input: ToolInput, signal: AbortSignal): Promise<ToolResult>;
}

/**
 * How a mock tool reacts to an abort request.
 *
 * Both behaviours must produce a correct outcome. The setting exists so the
 * difference can be demonstrated, not because correctness depends on it.
 */
export type MockToolMode = "cooperative" | "stubborn";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[]) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }
}
