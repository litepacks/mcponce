import type { HealthResponse, InfoResponse } from '../types.js';

/**
 * Checks if a given PID is currently active in the OS.
 */
export function isPidRunning(pid: number): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/**
 * Performs an HTTP GET request to /health on the target host/port.
 * Returns the HealthResponse if healthy and name matches, or null otherwise.
 */
export async function checkHealth(
  host: string,
  port: number,
  expectedName: string,
  timeoutMs = 1500
): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as HealthResponse;
    if (data && data.ok === true && data.name === expectedName) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches server diagnostic information from /info.
 */
export async function fetchInfo(
  host: string,
  port: number,
  timeoutMs = 2000
): Promise<InfoResponse | null> {
  try {
    const res = await fetch(`http://${host}:${port}/info`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as InfoResponse;
  } catch {
    return null;
  }
}
