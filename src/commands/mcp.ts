import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Command } from 'commander';
import { createMcpServer } from '../mcp/server.js';

/**
 * `librarium mcp` — start an MCP server over stdio so AI agents can drive
 * librarium directly. CRITICAL: in this mode stdout is the JSON-RPC protocol
 * stream. Nothing else may write to stdout — all diagnostics go to stderr, and
 * the research path uses the silent file-writing pipeline (no spinners/tables).
 */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start an MCP server over stdio for AI agent integration')
    .action(async () => {
      const log = (message: string): void => {
        process.stderr.write(`${message}\n`);
      };

      const server = createMcpServer({ onWarn: log });
      const transport = new StdioServerTransport();

      let closing = false;
      const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        try {
          await server.close();
        } catch {
          // Best effort.
        }
        process.exit(0);
      };

      // Clean shutdown on stdin close (client disconnect) and SIGINT/SIGTERM.
      process.stdin.on('close', () => void shutdown());
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      try {
        await server.connect(transport);
        log('[librarium] MCP server ready on stdio');
      } catch (e) {
        log(
          `[librarium] MCP server failed to start: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exitCode = 1;
      }
    });
}
