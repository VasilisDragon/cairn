import fs from 'node:fs';
import path from 'node:path';

export function captureDirectoryState(directoryPath) {
  const root = path.resolve(directoryPath);
  const exists = fs.existsSync(root);
  if (exists && !fs.statSync(root).isDirectory()) {
    throw new Error(`report preservation target is not a directory: ${root}`);
  }

  const files = new Map();
  const directories = new Set();
  if (exists) {
    directories.add('');
    for (const entry of walkDirectory(root)) {
      const relativePath = slash(path.relative(root, entry.path));
      if (entry.type === 'directory') {
        directories.add(relativePath);
      } else if (entry.type === 'file') {
        files.set(relativePath, fs.readFileSync(entry.path));
      }
    }
  }

  return {
    root,
    exists,
    directories,
    files,
  };
}

export function restoreDirectoryState(state) {
  const root = path.resolve(state.root);
  if (root !== state.root) {
    throw new Error('report preservation state root must be absolute');
  }

  if (!state.exists) {
    removeDirectoryContents(root);
    removeDirectoryIfEmpty(root);
    return;
  }

  fs.mkdirSync(root, { recursive: true });
  const expectedFiles = state.files || new Map();
  const expectedDirectories = state.directories || new Set(['']);
  const currentEntries = fs.existsSync(root) ? walkDirectory(root) : [];

  for (const entry of currentEntries.filter((item) => item.type === 'file')) {
    const relativePath = slash(path.relative(root, entry.path));
    if (!expectedFiles.has(relativePath)) {
      fs.unlinkSync(entry.path);
    }
  }

  for (const directory of expectedDirectories) {
    fs.mkdirSync(assertInsideRoot(root, path.join(root, directory)), { recursive: true });
  }
  for (const [relativePath, content] of expectedFiles.entries()) {
    const filePath = assertInsideRoot(root, path.join(root, relativePath));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  cleanupCreatedDirectories(root, expectedDirectories);
}

function walkDirectory(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const fullPath = assertInsideRoot(root, path.join(current, entry.name));
      if (entry.isDirectory()) {
        out.push({ type: 'directory', path: fullPath });
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push({ type: 'file', path: fullPath });
      }
    }
  }
  return out;
}

function removeDirectoryContents(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of walkDirectory(root).sort((a, b) => b.path.length - a.path.length)) {
    if (entry.type === 'file') {
      fs.unlinkSync(entry.path);
    } else if (entry.type === 'directory') {
      removeDirectoryIfEmpty(entry.path);
    }
  }
}

function cleanupCreatedDirectories(root, expectedDirectories) {
  const directories = walkDirectory(root)
    .filter((entry) => entry.type === 'directory')
    .sort((a, b) => b.path.length - a.path.length);
  for (const entry of directories) {
    const relativePath = slash(path.relative(root, entry.path));
    if (!expectedDirectories.has(relativePath)) {
      removeDirectoryIfEmpty(entry.path);
    }
  }
}

function removeDirectoryIfEmpty(directoryPath) {
  if (!fs.existsSync(directoryPath)) return;
  try {
    fs.rmdirSync(directoryPath);
  } catch (err) {
    if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') throw err;
  }
}

function assertInsideRoot(root, candidatePath) {
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to operate outside preserved directory: ${resolved}`);
  }
  return resolved;
}

function slash(value) {
  return value.replaceAll(path.sep, '/');
}

export default {
  captureDirectoryState,
  restoreDirectoryState,
};
