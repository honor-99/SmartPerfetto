// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'build',
  'out',
  'target',
  'secrets',
];

const DEFAULT_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  '.py',
  '.kts',
  '.gradle',
  '.mk',
  '.bp',
  '.rc',
  '.te',
  '.conf',
  '.properties',
  '.aidl',
  '.proto',
  '.xml',
]);

export interface PathSecurityGateOptions {
  allowlistRoots?: string[];
  excludeNames?: string[];
  allowedExtensions?: readonly string[];
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface PathPreviewFile {
  relativePath: string;
  sizeBytes: number;
}

export interface PathPreviewResult {
  rootPath: string;
  rootRealpath: string;
  acceptedFiles: PathPreviewFile[];
  skippedFiles: Array<{relativePath: string; reason: string}>;
  blocked: boolean;
  blockedReason?: string;
}

function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function configuredAllowlistRoots(): string[] {
  const roots = parsePathList(process.env.SMARTPERFETTO_CODEBASE_ROOTS);
  const unsafeDevRoot = process.env.SMARTPERFETTO_DEV_UNSAFE_CODEBASE_ROOT;
  if (unsafeDevRoot && process.env.NODE_ENV !== 'production') {
    roots.push(unsafeDevRoot);
  }
  return roots;
}

function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

export function isWithinAllowlist(target: string, allowlist: string[]): boolean {
  const realTarget = safeRealpath(target);
  if (!realTarget) return false;
  for (const root of allowlist) {
    const realRoot = safeRealpath(root);
    if (!realRoot) continue;
    const rel = path.relative(realRoot, realTarget);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function shouldExclude(relativePath: string, basename: string, excludeNames: string[]): boolean {
  if (basename.startsWith('.env')) return true;
  if (basename.endsWith('.log') || basename.endsWith('.bak')) return true;
  const parts = relativePath.split(path.sep);
  return parts.some(part => excludeNames.includes(part));
}

export class PathSecurityGate {
  // null means "read from env at call time" (supports dotenv loaded after module init)
  private readonly allowlistRootsOverride: string[] | null;
  private readonly excludeNames: string[];
  private readonly allowedExtensions: Set<string>;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;

  constructor(options: PathSecurityGateOptions = {}) {
    this.allowlistRootsOverride = options.allowlistRoots ?? null;
    this.excludeNames = options.excludeNames ?? DEFAULT_EXCLUDES;
    this.allowedExtensions = new Set(options.allowedExtensions ?? DEFAULT_EXTENSIONS);
    this.maxFileBytes = options.maxFileBytes ?? 200 * 1024;
    this.maxFiles = options.maxFiles ?? 50_000;
  }

  preview(rootPath: string): PathPreviewResult {
    // Read env lazily so SMARTPERFETTO_CODEBASE_ROOTS set via dotenv (loaded after
    // module init in ESM) is visible on the first real request.
    const allowlistRoots = this.allowlistRootsOverride ?? configuredAllowlistRoots();
    const rootRealpath = safeRealpath(rootPath);
    if (!rootRealpath) {
      return {
        rootPath,
        rootRealpath: '',
        acceptedFiles: [],
        skippedFiles: [],
        blocked: true,
        blockedReason: 'root_not_found',
      };
    }
    if (allowlistRoots.length === 0 || !isWithinAllowlist(rootRealpath, allowlistRoots)) {
      return {
        rootPath,
        rootRealpath,
        acceptedFiles: [],
        skippedFiles: [],
        blocked: true,
        blockedReason: 'root_outside_allowlist',
      };
    }

    const acceptedFiles: PathPreviewFile[] = [];
    const skippedFiles: Array<{relativePath: string; reason: string}> = [];
    const stack = [rootRealpath];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, {withFileTypes: true});
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const realPath = safeRealpath(fullPath);
        if (!realPath || !isWithinAllowlist(realPath, [rootRealpath])) {
          skippedFiles.push({
            relativePath: path.relative(rootRealpath, fullPath),
            reason: 'symlink_outside_root',
          });
          continue;
        }
        const relativePath = path.relative(rootRealpath, realPath);
        if (shouldExclude(relativePath, entry.name, this.excludeNames)) {
          if (entry.isFile()) skippedFiles.push({relativePath, reason: 'excluded'});
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(realPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name);
        if (!this.allowedExtensions.has(ext)) {
          skippedFiles.push({relativePath, reason: 'extension_not_allowed'});
          continue;
        }
        const stat = fs.statSync(realPath);
        if (stat.size > this.maxFileBytes) {
          skippedFiles.push({relativePath, reason: 'file_too_large'});
          continue;
        }
        acceptedFiles.push({relativePath, sizeBytes: stat.size});
        if (acceptedFiles.length > this.maxFiles) {
          return {
            rootPath,
            rootRealpath,
            acceptedFiles,
            skippedFiles,
            blocked: true,
            blockedReason: 'too_many_files',
          };
        }
      }
    }

    acceptedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    skippedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      rootPath,
      rootRealpath,
      acceptedFiles,
      skippedFiles,
      blocked: false,
    };
  }
}

