/**
 * Claude CLI transport for the subagent handler.
 *
 * Shells out to the local `claude` binary in --print mode, using whatever
 * auth that CLI is logged into. For Max/Pro subscribers this routes
 * inference through their subscription instead of metered API tokens.
 *
 * Limitations vs the Anthropic SDK transport:
 *   - Single-turn only. The CLI returns a final text answer; no tool_use
 *     blocks are surfaced. The subagent loop sees end_turn after one call.
 *   - No tool registry. Brain tools are skipped at the handler level when
 *     this transport is selected.
 *   - No usage accounting. CLI doesn't report token counts; rollup reads 0.
 */

import { spawn } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from './subagent.ts';

export interface ClaudeCliOptions {
  /** Override the binary name. Defaults to "claude". */
  binary?: string;
  /** Extra args appended after the built-in flags. */
  extraArgs?: string[];
}

export function makeClaudeCliClient(opts: ClaudeCliOptions = {}): MessagesClient {
  const binary = opts.binary ?? 'claude';
  const extraArgs = opts.extraArgs ?? [];

  return {
    async create(params, callOpts) {
      const promptText = extractPromptText(params.messages);
      const systemText = extractSystemText(params.system);

      const args = [
        '--print',
        '--permission-mode', 'bypassPermissions',
        '--model', params.model,
        ...extraArgs,
      ];
      if (systemText) {
        args.push('--append-system-prompt', systemText);
      }

      const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      };
      callOpts?.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdin.write(promptText);
      child.stdin.end();

      const [stdout, stderr, code] = await Promise.all([
        collectStream(child.stdout),
        collectStream(child.stderr),
        new Promise<number>((resolve) => {
          child.on('close', (c) => resolve(c ?? 0));
        }),
      ]);

      callOpts?.signal?.removeEventListener?.('abort', onAbort);

      if (code !== 0) {
        // CLI sometimes writes diagnostic output to stdout instead of
        // stderr (e.g. auth errors, model rejections). Surface both so
        // the failed-job error message is actionable instead of just
        // "exit code 1".
        const parts: string[] = [];
        if (stderr.trim()) parts.push(`stderr: ${truncate(stderr.trim(), 1000)}`);
        if (stdout.trim()) parts.push(`stdout: ${truncate(stdout.trim(), 1000)}`);
        const detail = parts.length > 0 ? parts.join(' | ') : '(no output)';
        throw new Error(`claude-cli runtime failed (exit ${code}): ${detail}`);
      }

      return {
        id: `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: stdout.trim() }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        } as Anthropic.Message['usage'],
      } as Anthropic.Message;
    },
  };
}

function extractPromptText(messages: Anthropic.MessageParam[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return '';
  return blocksToText(lastUser.content);
}

function extractSystemText(system: Anthropic.MessageCreateParamsNonStreaming['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  }
  return '';
}

function blocksToText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`;
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}
