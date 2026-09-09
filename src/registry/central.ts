import fs from 'node:fs';
import path from 'node:path';
import { getDefaultDataDir } from '../runtime/paths.js';
import { checkHealth, isPidRunning } from '../runtime/health.js';

export interface ServerRegistryEntry {
  name: string;
  version: string;
  status: 'running' | 'stopped';
  pid?: number;
  port?: number;
  host?: string;
  dataDir: string;
  logDir: string;
  startedAt?: string;
  lastSeen?: string;
}

export interface RegistryFileFormat {
  version: number;
  servers: Record<string, ServerRegistryEntry>;
}

export class CentralRegistry {
  private registryPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.registryPath = path.resolve(customPath);
    } else if (process.env.MCPONCE_REGISTRY_PATH) {
      this.registryPath = path.resolve(process.env.MCPONCE_REGISTRY_PATH);
    } else {
      const baseDir = getDefaultDataDir('mcponce');
      this.registryPath = path.join(baseDir, 'servers.json');
    }
  }

  get path(): string {
    return this.registryPath;
  }

  private load(): RegistryFileFormat {
    try {
      if (!fs.existsSync(this.registryPath)) {
        return { version: 1, servers: {} };
      }
      const content = fs.readFileSync(this.registryPath, 'utf-8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object' && data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers)) {
        return data as RegistryFileFormat;
      }
      return { version: 1, servers: {} };
    } catch {
      return { version: 1, servers: {} };
    }
  }

  private save(data: RegistryFileFormat): void {
    try {
      const dir = path.dirname(this.registryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = path.join(dir, `.servers.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.registryPath);
    } catch {
      // Safe fallback if rename fails across partitions
      try {
        fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2), 'utf-8');
      } catch {}
    }
  }

  /**
   * Registers or updates a server entry in the central registry.
   */
  async register(entry: ServerRegistryEntry): Promise<void> {
    const data = this.load();
    data.servers[entry.name] = {
      ...data.servers[entry.name],
      ...entry,
      lastSeen: new Date().toISOString()
    };
    this.save(data);
  }

  /**
   * Updates the status of a registered server.
   */
  async updateStatus(
    name: string,
    status: 'running' | 'stopped',
    patch?: Partial<ServerRegistryEntry>
  ): Promise<void> {
    const data = this.load();
    if (!data.servers[name]) {
      return;
    }

    data.servers[name] = {
      ...data.servers[name],
      ...patch,
      status,
      lastSeen: new Date().toISOString()
    };

    if (status === 'stopped') {
      delete data.servers[name].pid;
      delete data.servers[name].port;
    }

    this.save(data);
  }

  /**
   * Returns all servers, automatically reconciling liveness.
   * If a server recorded as 'running' is dead, updates its status to 'stopped'.
   */
  async getAll(reconcile = true): Promise<ServerRegistryEntry[]> {
    const data = this.load();
    let updated = false;

    for (const [name, server] of Object.entries(data.servers)) {
      if (reconcile && server.status === 'running') {
        let isAlive = false;
        if (server.pid && isPidRunning(server.pid)) {
          if (server.port && server.host) {
            let health = await checkHealth(server.host, server.port, server.name, 2000);
            if (!health?.ok) {
              await new Promise((r) => setTimeout(r, 100));
              health = await checkHealth(server.host, server.port, server.name, 2000);
            }
            if (health?.ok) {
              isAlive = true;
            }
          }
        }

        if (!isAlive) {
          server.status = 'stopped';
          delete server.pid;
          delete server.port;
          updated = true;
        }
      }
    }

    if (updated) {
      this.save(data);
    }

    return Object.values(data.servers);
  }

  /**
   * Gets a specific server by name.
   */
  async get(name: string): Promise<ServerRegistryEntry | null> {
    const data = this.load();
    const server = data.servers[name];
    if (!server) return null;

    if (server.status === 'running' && server.pid) {
      let isAlive = false;
      if (isPidRunning(server.pid) && server.port && server.host) {
        let health = await checkHealth(server.host, server.port, server.name, 2000);
        if (!health?.ok) {
          await new Promise((r) => setTimeout(r, 100));
          health = await checkHealth(server.host, server.port, server.name, 2000);
        }
        if (health?.ok) isAlive = true;
      }
      if (!isAlive) {
        server.status = 'stopped';
        delete server.pid;
        delete server.port;
        this.save(data);
      }
    }

    return server;
  }

  /**
   * Removes a server completely from the registry.
   */
  async remove(name: string): Promise<boolean> {
    const data = this.load();
    if (data.servers[name]) {
      delete data.servers[name];
      this.save(data);
      return true;
    }
    return false;
  }

  /**
   * Removes all stopped servers from the registry.
   * Returns the count of removed servers.
   */
  async clean(): Promise<number> {
    const servers = await this.getAll(true);
    const data = this.load();
    let removedCount = 0;

    for (const s of servers) {
      if (s.status === 'stopped') {
        delete data.servers[s.name];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.save(data);
    }

    return removedCount;
  }

  /**
   * Attempts to stop a running server.
   */
  async stop(name: string): Promise<boolean> {
    const server = await this.get(name);
    if (!server || server.status !== 'running' || !server.pid) {
      return false;
    }

    try {
      process.kill(server.pid, 'SIGTERM');
      // Wait up to 1.5s for process to exit
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!isPidRunning(server.pid)) {
          break;
        }
      }
    } catch {}

    await this.updateStatus(name, 'stopped');
    return true;
  }
}
