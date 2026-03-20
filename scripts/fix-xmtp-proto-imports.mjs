import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(
  'node_modules',
  '@xmtp',
  'consent-proof-signature',
  'node_modules',
  '@xmtp',
  'proto',
  'ts',
  'dist',
  'esm',
);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const source = await fs.readFile(fullPath, 'utf8');
    let rewritten = source.replaceAll(
      /(["'][^"']+?\.pb)(["'])/g,
      '$1.js$2',
    );
    rewritten = rewritten
        .split('"protobufjs/minimal"')
        .join('"protobufjs/minimal.js"')
        .split("'protobufjs/minimal'")
        .join("'protobufjs/minimal.js'");

    if (rewritten !== source) {
      await fs.writeFile(fullPath, rewritten, 'utf8');
    }
  }
}

try {
  await walk(root);
  console.log('[fix-xmtp-proto-imports] XMTP proto ESM imports rewritten');
} catch (error) {
  console.warn('[fix-xmtp-proto-imports] Skipped:', error.message);
}
