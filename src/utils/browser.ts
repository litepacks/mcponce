import { exec } from 'node:child_process';

/**
 * Opens a URL in the user's default web browser across macOS, Windows, and Linux.
 * Safely fails silently in headless or CI environments.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.env.CI || process.env.NO_BROWSER) {
      resolve(false);
      return;
    }

    let command: string;
    switch (process.platform) {
      case 'darwin':
        command = `open "${url}"`;
        break;
      case 'win32':
        command = `start "" "${url}"`;
        break;
      default:
        command = `xdg-open "${url}"`;
        break;
    }

    try {
      exec(command, (error) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
}
