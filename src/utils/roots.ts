import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Root } from './sampling.js';

/**
 * Converts a file URI (e.g. "file:///Users/dev/project") or local string path into an absolute normalized path.
 */
export function rootToPath(root: Root | string): string {
  const uri = typeof root === 'string' ? root : root.uri;
  if (uri.startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(uri));
    } catch {
      return path.resolve(uri.replace(/^file:\/\//, ''));
    }
  }
  return path.resolve(uri);
}

/**
 * Checks whether a target path is securely contained within any of the provided workspace roots.
 * Guards against directory traversal attacks (e.g. "../../../etc/passwd").
 */
export function isPathInWorkspace(roots: Array<Root | string>, targetPath: string): boolean {
  if (!roots || roots.length === 0) return false;
  const resolvedTarget = path.resolve(targetPath);

  for (const root of roots) {
    const rootPath = rootToPath(root);
    // Path must either equal the root or be a child of the root
    if (resolvedTarget === rootPath) {
      return true;
    }
    const relative = path.relative(rootPath, resolvedTarget);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return true;
    }
  }

  return false;
}

/**
 * Finds which workspace root contains the given target path, or undefined if none match.
 */
export function findWorkspaceRoot(
  roots: Array<Root | string>,
  targetPath: string
): Root | undefined {
  if (!roots || roots.length === 0) return undefined;
  const resolvedTarget = path.resolve(targetPath);

  for (const root of roots) {
    const rootPath = rootToPath(root);
    if (resolvedTarget === rootPath) {
      return typeof root === 'string' ? { uri: root } : root;
    }
    const relative = path.relative(rootPath, resolvedTarget);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return typeof root === 'string' ? { uri: root } : root;
    }
  }

  return undefined;
}

/**
 * Resolves a relative path against the primary or first workspace root,
 * ensuring the resulting path remains securely inside that workspace.
 * Throws an error if the path attempts to traverse outside the workspace.
 */
export function resolveWorkspacePath(
  roots: Array<Root | string>,
  relativePath: string
): string {
  if (!roots || roots.length === 0) {
    throw new Error('Cannot resolve workspace path: No active workspace roots provided.');
  }

  const primaryRoot = rootToPath(roots[0]);
  const resolved = path.resolve(primaryRoot, relativePath);

  if (!isPathInWorkspace([primaryRoot], resolved)) {
    throw new Error(
      `Path traversal denied: Path "${relativePath}" resolves to "${resolved}" which is outside workspace root "${primaryRoot}".`
    );
  }

  return resolved;
}
