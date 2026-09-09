import type {
  Logger,
  ToolProgressNotification,
  ToolProgressReport,
  ToolProgressReporter
} from '../types.js';

export interface CreateProgressReporterOptions {
  toolName: string;
  progressToken?: string | number;
  sendMcpNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
  onProgress?: (progress: ToolProgressNotification) => void | Promise<void>;
  logger?: Logger;
}

/**
 * Creates a unified progress reporter that dispatches progress events to:
 * 1. The remote MCP client (via notifications/progress) if progressToken is present.
 * 2. Programmatic onProgress listeners (e.g. from app.callTool or CLI).
 *
 * Supports both positional reportProgress(current, total, message)
 * and object reportProgress({ progress, total, message }) signatures.
 */
export function createProgressReporter(
  options: CreateProgressReporterOptions
): ToolProgressReporter {
  const reporter = async (
    arg1: number | ToolProgressReport,
    arg2?: number,
    arg3?: string
  ): Promise<void> => {
    let currentProgress: number;
    let totalUnits: number | undefined;
    let msg: string | undefined;

    if (typeof arg1 === 'object' && arg1 !== null) {
      currentProgress = typeof arg1.progress === 'number' ? arg1.progress : Number(arg1.progress);
      totalUnits =
        arg1.total !== undefined
          ? typeof arg1.total === 'number'
            ? arg1.total
            : Number(arg1.total)
          : undefined;
      msg = arg1.message !== undefined ? String(arg1.message) : undefined;
    } else {
      currentProgress = typeof arg1 === 'number' ? arg1 : Number(arg1);
      totalUnits =
        arg2 !== undefined ? (typeof arg2 === 'number' ? arg2 : Number(arg2)) : undefined;
      msg = arg3 !== undefined ? String(arg3) : undefined;
    }

    if (!Number.isFinite(currentProgress) || currentProgress < 0) {
      currentProgress = 0;
    }

    if (totalUnits !== undefined && (!Number.isFinite(totalUnits) || totalUnits < 0)) {
      totalUnits = undefined;
    }

    const notification: ToolProgressNotification = {
      tool: options.toolName,
      progress: currentProgress,
      total: totalUnits,
      message: msg,
      progressToken: options.progressToken,
      timestamp: new Date().toISOString()
    };

    options.logger?.debug?.('tool:progress', {
      name: options.toolName,
      progress: currentProgress,
      total: totalUnits,
      message: msg,
      progressToken: options.progressToken
    });

    // 1. Dispatch over MCP protocol if client requested progress
    if (options.progressToken !== undefined && typeof options.sendMcpNotification === 'function') {
      try {
        const params: {
          progressToken: string | number;
          progress: number;
          total?: number;
          message?: string;
        } = {
          progressToken: options.progressToken,
          progress: currentProgress
        };
        if (totalUnits !== undefined) {
          params.total = totalUnits;
        }
        if (msg !== undefined) {
          params.message = msg;
        }

        await options.sendMcpNotification({
          method: 'notifications/progress',
          params
        });
      } catch (err: any) {
        options.logger?.warn?.('Failed to send MCP progress notification', {
          tool: options.toolName,
          error: err?.message || String(err)
        });
      }
    }

    // 2. Dispatch to programmatic listener
    if (typeof options.onProgress === 'function') {
      try {
        await options.onProgress(notification);
      } catch (err: any) {
        options.logger?.warn?.('onProgress listener threw an error', {
          tool: options.toolName,
          error: err?.message || String(err)
        });
      }
    }
  };

  return reporter as ToolProgressReporter;
}
