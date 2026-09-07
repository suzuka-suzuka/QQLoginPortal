import {
  access,
  copyFile,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOADER_MAIN = './qq-login-portal-loader.cjs';
export const LOADER_FILE = 'qq-login-portal-loader.cjs';
export const METADATA_FILE = 'qq-login-portal-loader.json';
export const BACKUP_FILE = 'package.json.qq-login-portal.backup';

// Compatibility with the short-lived embedded preview. These names are only
// used to recover the original QQ entry while moving to the standalone loader.
const LEGACY_LOADER_MAIN = './snowluma-login-loader.cjs';
const LEGACY_LOADER_FILE = 'snowluma-login-loader.cjs';
const LEGACY_METADATA_FILE = 'snowluma-login-loader.json';
const LEGACY_BACKUP_FILE = 'package.json.snowluma-login.backup';

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function paths(resourcesDir) {
  const root = path.resolve(resourcesDir);
  return {
    root,
    packagePath: path.join(root, 'package.json'),
    loaderPath: path.join(root, LOADER_FILE),
    metadataPath: path.join(root, METADATA_FILE),
    backupPath: path.join(root, BACKUP_FILE),
    legacyLoaderPath: path.join(root, LEGACY_LOADER_FILE),
    legacyMetadataPath: path.join(root, LEGACY_METADATA_FILE),
    legacyBackupPath: path.join(root, LEGACY_BACKUP_FILE),
  };
}

function validateOriginalMain(value, root) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('QQ package.json 缺少 main');
  const loaderNames = new Set([LOADER_FILE, LEGACY_LOADER_FILE]);
  if (value === LOADER_MAIN || value === LEGACY_LOADER_MAIN || loaderNames.has(path.basename(value).toLowerCase())) {
    throw new Error('无法从当前 package.json 推断 QQ 原始入口');
  }
  if (path.isAbsolute(value)) throw new Error('QQ package.json 的原始 main 必须是相对路径');
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QQ package.json 的原始 main 越过 resources 目录');
  if (/napcat/i.test(value)) throw new Error('检测到已有 NapCat 加载入口；不能叠加安装 QQ Login Portal 加载器');
  return value;
}

async function atomicWrite(target, content, mode = 0o644) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    await rename(temp, target);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await copyFile(temp, target);
    await unlink(temp);
  }
}

async function inspectActiveLoader(target, { legacy = false } = {}) {
  const loaderPath = legacy ? target.legacyLoaderPath : target.loaderPath;
  const metadataPath = legacy ? target.legacyMetadataPath : target.metadataPath;
  if (!await exists(loaderPath) || !await exists(metadataPath)) {
    return {
      installed: false,
      state: 'incomplete',
      message: legacy
        ? 'QQ 已指向旧版登录加载器，但旧版文件不完整'
        : 'QQ 已指向 QQ Login Portal 加载器，但加载器文件不完整',
    };
  }
  try {
    const metadata = parseJson(await readFile(metadataPath, 'utf8'), metadataPath);
    if (metadata.schemaVersion !== 1) throw new Error('加载器元数据版本不受支持');
    const originalMain = validateOriginalMain(metadata.originalMain, target.root);
    if (legacy) {
      return {
        installed: false,
        state: 'legacy_loader',
        message: '检测到旧版嵌入式登录加载器；执行 loader install 可安全迁移',
        originalMain,
        legacy: true,
      };
    }
    return { installed: true, state: 'installed', message: 'QQ Login Portal 加载器已安装', originalMain };
  } catch (error) {
    return { installed: false, state: 'invalid_metadata', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectLoader(resourcesDir) {
  const target = paths(resourcesDir);
  let packageText;
  try {
    packageText = await readFile(target.packagePath, 'utf8');
  } catch (error) {
    return {
      installed: false,
      state: 'missing_package',
      message: `无法读取 ${target.packagePath}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let pkg;
  try { pkg = parseJson(packageText, target.packagePath); } catch (error) {
    return { installed: false, state: 'invalid_package', message: error.message };
  }
  if (pkg.main === LOADER_MAIN) return inspectActiveLoader(target);
  if (pkg.main === LEGACY_LOADER_MAIN) return inspectActiveLoader(target, { legacy: true });
  return {
    installed: false,
    state: /napcat/i.test(String(pkg.main ?? '')) ? 'conflicting_loader' : 'not_installed',
    message: /napcat/i.test(String(pkg.main ?? ''))
      ? `QQ 当前入口 ${String(pkg.main)} 看起来属于 NapCat，不能叠加加载器`
      : 'QQ Login Portal 加载器尚未安装',
    currentMain: typeof pkg.main === 'string' ? pkg.main : '',
  };
}

async function createBackup(target, {
  originalMain,
  packageText,
  packageMode,
  migratingLegacy,
}) {
  if (await exists(target.backupPath)) {
    const existingText = await readFile(target.backupPath, 'utf8');
    const existing = parseJson(existingText, target.backupPath);
    if (existing.main !== originalMain) {
      throw new Error(`${target.backupPath} 已存在且入口与当前 QQ 不同；请先人工核对，不会覆盖备份`);
    }
    return false;
  }

  let backupText = packageText;
  if (migratingLegacy) {
    if (await exists(target.legacyBackupPath)) {
      backupText = await readFile(target.legacyBackupPath, 'utf8');
      const legacyBackup = parseJson(backupText, target.legacyBackupPath);
      if (legacyBackup.main !== originalMain) {
        throw new Error(`${target.legacyBackupPath} 与旧版元数据记录的 QQ 原始入口不一致`);
      }
    } else {
      const restored = parseJson(packageText, target.packagePath);
      restored.main = originalMain;
      backupText = `${JSON.stringify(restored, null, 2)}\n`;
    }
  }

  const handle = await open(target.backupPath, 'wx', packageMode || 0o644);
  try { await handle.writeFile(backupText, 'utf8'); } finally { await handle.close(); }
  return true;
}

export async function installLoader(resourcesDir, {
  loaderSource = fileURLToPath(new URL('./qq-loader.cjs', import.meta.url)),
} = {}) {
  const target = paths(resourcesDir);
  const before = await inspectLoader(target.root);
  const loaderContent = await readFile(loaderSource);
  if (before.installed) {
    const installedContent = await readFile(target.loaderPath);
    const installedMode = (await stat(target.loaderPath)).mode & 0o777;
    const modeIsSafe = process.platform === 'win32' || installedMode === 0o644;
    if (loaderContent.equals(installedContent) && modeIsSafe) {
      return { changed: false, ...before };
    }
    await atomicWrite(target.loaderPath, loaderContent, 0o644);
    const after = await inspectLoader(target.root);
    if (!after.installed) throw new Error(`加载器刷新后校验失败：${after.message}`);
    return { changed: true, refreshedLoader: true, ...after };
  }
  if (!['not_installed', 'legacy_loader'].includes(before.state)) throw new Error(before.message);

  const packageText = await readFile(target.packagePath, 'utf8');
  const pkg = parseJson(packageText, target.packagePath);
  const migratingLegacy = before.state === 'legacy_loader';
  const originalMain = migratingLegacy
    ? before.originalMain
    : validateOriginalMain(pkg.main, target.root);
  const packageMode = (await stat(target.packagePath)).mode & 0o777;
  const backupCreated = await createBackup(target, {
    originalMain,
    packageText,
    packageMode,
    migratingLegacy,
  });

  await atomicWrite(target.loaderPath, loaderContent, 0o644);
  await atomicWrite(target.metadataPath, `${JSON.stringify({ schemaVersion: 1, originalMain }, null, 2)}\n`, 0o644);

  pkg.main = LOADER_MAIN;
  await atomicWrite(target.packagePath, `${JSON.stringify(pkg, null, 2)}\n`, packageMode || 0o644);
  const after = await inspectLoader(target.root);
  if (!after.installed) throw new Error(`加载器写入后校验失败：${after.message}`);
  return { changed: true, backupCreated, migratedLegacy: migratingLegacy, ...after };
}

export async function restoreLoader(resourcesDir) {
  const target = paths(resourcesDir);
  const currentText = await readFile(target.packagePath, 'utf8');
  const current = parseJson(currentText, target.packagePath);
  const usingCurrent = current.main === LOADER_MAIN;
  const usingLegacy = current.main === LEGACY_LOADER_MAIN;
  if (!usingCurrent && !usingLegacy) {
    return { changed: false, state: 'not_installed', message: 'QQ 当前未使用 QQ Login Portal 加载器' };
  }
  const backupPath = usingLegacy ? target.legacyBackupPath : target.backupPath;
  if (!await exists(backupPath)) throw new Error(`缺少原始入口备份：${backupPath}`);
  const backupText = await readFile(backupPath, 'utf8');
  const backup = parseJson(backupText, backupPath);
  validateOriginalMain(backup.main, target.root);
  const packageMode = (await stat(target.packagePath)).mode & 0o777;
  await atomicWrite(target.packagePath, backupText, packageMode || 0o644);
  return { changed: true, state: 'restored', message: `已恢复 QQ 原始入口 ${backup.main}`, originalMain: backup.main };
}
