import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BACKUP_FILE,
  inspectLoader,
  installLoader,
  LOADER_FILE,
  LOADER_MAIN,
  METADATA_FILE,
  restoreLoader,
} from '../src/loader-install.mjs';

async function withResources(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qq-login-portal-loader-'));
  const loaderSource = path.join(root, 'source-loader.cjs');
  await writeFile(loaderSource, 'module.exports = {};\n');
  try { await run(root, loaderSource); } finally { await rm(root, { recursive: true, force: true }); }
}

test('installs a reversible QQ package loader and records the original entry', async () => {
  await withResources(async (root, loaderSource) => {
    const original = { name: 'QQ', version: '3.2.30', main: './application.asar/app_launcher/index.js' };
    const originalText = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(path.join(root, 'package.json'), originalText);

    const installed = await installLoader(root, { loaderSource });
    assert.equal(installed.changed, true);
    assert.equal(installed.installed, true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).main, LOADER_MAIN);
    assert.equal(JSON.parse(await readFile(path.join(root, METADATA_FILE), 'utf8')).originalMain, original.main);
    assert.equal(await readFile(path.join(root, BACKUP_FILE), 'utf8'), originalText);
    assert.equal((await inspectLoader(root)).installed, true);

    const restored = await restoreLoader(root);
    assert.equal(restored.changed, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), original);
  });
});

test('does not overwrite the original backup on a repeated install', async () => {
  await withResources(async (root, loaderSource) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: './application.asar/app_launcher/index.js' }));
    await installLoader(root, { loaderSource });
    const backupBefore = await readFile(path.join(root, BACKUP_FILE), 'utf8');
    const second = await installLoader(root, { loaderSource });
    assert.equal(second.changed, false);
    assert.equal(await readFile(path.join(root, BACKUP_FILE), 'utf8'), backupBefore);
  });
});

test('refreshes an installed loader without replacing the original package backup', async () => {
  await withResources(async (root, loaderSource) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: './application.asar/app_launcher/index.js' }));
    await installLoader(root, { loaderSource });
    const backupBefore = await readFile(path.join(root, BACKUP_FILE), 'utf8');
    await writeFile(loaderSource, 'module.exports = { refreshed: true };\n');

    const refreshed = await installLoader(root, { loaderSource });

    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.refreshedLoader, true);
    assert.equal(await readFile(path.join(root, LOADER_FILE), 'utf8'), 'module.exports = { refreshed: true };\n');
    assert.equal(await readFile(path.join(root, BACKUP_FILE), 'utf8'), backupBefore);
  });
});

test('migrates the old embedded loader without losing or replacing its original QQ backup', async () => {
  await withResources(async (root, loaderSource) => {
    const original = { name: 'QQ', version: '3.2.30', main: './application.asar/app_launcher/index.js' };
    const originalText = `${JSON.stringify(original, null, 2)}\n`;
    await Promise.all([
      writeFile(path.join(root, 'package.json'), JSON.stringify({ ...original, main: './snowluma-login-loader.cjs' })),
      writeFile(path.join(root, 'snowluma-login-loader.cjs'), 'module.exports = {};\n'),
      writeFile(path.join(root, 'snowluma-login-loader.json'), JSON.stringify({ schemaVersion: 1, originalMain: original.main })),
      writeFile(path.join(root, 'package.json.snowluma-login.backup'), originalText),
    ]);

    const before = await inspectLoader(root);
    assert.equal(before.state, 'legacy_loader');
    const migrated = await installLoader(root, { loaderSource });
    assert.equal(migrated.migratedLegacy, true);
    assert.equal(migrated.installed, true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).main, LOADER_MAIN);
    assert.equal(await readFile(path.join(root, BACKUP_FILE), 'utf8'), originalText);
    assert.equal(await readFile(path.join(root, 'package.json.snowluma-login.backup'), 'utf8'), originalText);
  });
});

test('refuses to stack the login loader on a NapCat entry', async () => {
  await withResources(async (root, loaderSource) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: './loadNapCat.cjs' }));
    const status = await inspectLoader(root);
    assert.equal(status.state, 'conflicting_loader');
    await assert.rejects(installLoader(root, { loaderSource }), /NapCat/);
  });
});
