import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AddressInfo } from 'node:net';

export interface HttpServerHandle {
  server: ServerType;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/**
 * Starts the Hono application on a Node.js HTTP server.
 * When port is 0, the OS assigns an available dynamic port.
 */
export async function startHttpServer(
  app: Hono<any, any, any>,
  host: string = '127.0.0.1',
  port: number = 0
): Promise<HttpServerHandle> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let actualPort = port;

    const server = serve(
      {
        fetch: app.fetch,
        hostname: host,
        port
      },
      (info) => {
        actualPort = info.port;
        if (!resolved) {
          resolved = true;
          resolve({
            server,
            port: actualPort,
            host,
            close: async () => {
              return new Promise<void>((res) => {
                const timeout = setTimeout(() => res(), 2000);
                if (typeof (server as any).closeAllConnections === 'function') {
                  try {
                    (server as any).closeAllConnections();
                  } catch {}
                }
                server.close(() => {
                  clearTimeout(timeout);
                  res();
                });
              });
            }
          });
        }
      }
    );

    server.on('error', (err: any) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}
