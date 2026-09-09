import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Logger } from '../types.js';

export interface StdioProxyHandle {
  done: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Bridges standard input/output with the local Streamable HTTP MCP server.
 * All diagnostic logs are sent to the logger (and stderr if configured),
 * ensuring process.stdout remains strictly clean for MCP JSON-RPC protocol messages.
 */
export async function startStdioProxy(
  mcpUrl: string,
  logger?: Logger
): Promise<StdioProxyHandle> {
  const stdioTransport = new StdioServerTransport();
  const httpTransport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  let isClosed = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let onStdinEnd: (() => void) | undefined;

  const cleanup = async () => {
    if (isClosed) return;
    isClosed = true;

    if (onStdinEnd) {
      process.stdin.removeListener('end', onStdinEnd);
      process.stdin.removeListener('close', onStdinEnd);
    }

    try {
      await httpTransport.close();
    } catch {}

    try {
      await stdioTransport.close();
    } catch {}

    if (onStdoutError) {
      process.stdout.removeListener('error', onStdoutError);
    }
    if (onStdinError) {
      process.stdin.removeListener('error', onStdinError);
    }

    resolveDone();
  };

  onStdinEnd = () => cleanup();
  process.stdin.once('end', onStdinEnd);
  process.stdin.once('close', onStdinEnd);

  // Guard against unhandled EPIPE when the MCP client abruptly disconnects
  const onStdoutError = (err: any) => {
    if (err.code === 'EPIPE') {
      logger?.debug('Stdout stream closed with EPIPE (client disconnected)');
      cleanup();
    }
  };
  process.stdout.on('error', onStdoutError);

  const onStdinError = (err: any) => {
    logger?.debug('Stdin stream error', { error: err.message || String(err) });
    cleanup();
  };
  process.stdin.on('error', onStdinError);

  // Bridge client message (stdin) -> local HTTP server
  stdioTransport.onmessage = async (msg) => {
    try {
      await httpTransport.send(msg);
    } catch (err: any) {
      logger?.error('Error forwarding message from stdio to http', {
        error: err.message || String(err)
      });
      // Prevent client from hanging indefinitely on error
      const reqId = (msg as any)?.id;
      if (reqId !== undefined && reqId !== null) {
        try {
          await stdioTransport.send({
            jsonrpc: '2.0',
            id: reqId,
            error: {
              code: -32603,
              message: `Bridge failed to forward request: ${err.message || String(err)}`
            }
          });
        } catch {}
      }
    }
  };

  // Bridge local HTTP server -> client (stdout)
  httpTransport.onmessage = async (msg) => {
    try {
      await stdioTransport.send(msg);
    } catch (err: any) {
      logger?.error('Error forwarding message from http to stdio', {
        error: err.message || String(err)
      });
    }
  };

  stdioTransport.onclose = () => {
    cleanup();
  };

  httpTransport.onclose = () => {
    cleanup();
  };

  stdioTransport.onerror = (err) => {
    logger?.error('Stdio transport error', { error: err.message || String(err) });
  };

  httpTransport.onerror = (err) => {
    logger?.error('HTTP client transport error', { error: err.message || String(err) });
  };

  // Start both transports
  await httpTransport.start();
  await stdioTransport.start();

  logger?.debug('Stdio proxy successfully started', { mcpUrl });

  return {
    done,
    close: cleanup
  };
}
