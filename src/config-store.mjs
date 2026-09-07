import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeConfig, UIN_RE } from './config.mjs';

function publicInstance(instance) {
  return {
    id: instance.id,
    uin: instance.uin,
    autostart: instance.autostart,
  };
}

function publicSettings(config) {
  return {
    auth: {
      passwordConfigured: Boolean(config.auth.password || config.auth.passwordHash),
      sessionTtlMinutes: config.auth.sessionTtlMinutes,
      secureCookie: config.auth.secureCookie,
    },
    listen: { ...config.listen },
    management: {
      instanceRoot: config.management.instanceRoot,
      maxInstances: config.management.maxInstances,
    },
  };
}

function ensureObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export class ConfigFileStore {
  constructor(configPath, liveConfig) {
    this.configPath = path.resolve(configPath);
    this.configDir = path.dirname(this.configPath);
    this.liveConfig = liveConfig;
    this.tail = Promise.resolve();
  }

  enqueue(operation) {
    const pending = this.tail.then(operation, operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  async readRaw() {
    const source = await readFile(this.configPath, 'utf8');
    try {
      return JSON.parse(source);
    } catch {
      throw new Error(`配置文件不是有效 JSON：${this.configPath}`);
    }
  }

  async writeRaw(raw) {
    const temporary = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.configPath);
      await chmod(this.configPath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  replaceLiveConfig(next) {
    for (const key of Object.keys(this.liveConfig)) delete this.liveConfig[key];
    Object.assign(this.liveConfig, next);
  }

  mutate(mutator) {
    return this.enqueue(async () => {
      const raw = await this.readRaw();
      const current = normalizeConfig(raw, this.configDir);
      const result = await mutator(raw, current);
      const next = normalizeConfig(raw, this.configDir);
      await this.writeRaw(raw);
      this.replaceLiveConfig(next);
      return { result, config: next };
    });
  }

  settings() {
    return publicSettings(this.liveConfig);
  }

  async addInstance({ uin, autostart = false } = {}) {
    const normalizedUin = String(uin ?? '').trim();
    if (!UIN_RE.test(normalizedUin)) throw new Error('请输入有效 QQ 号');

    const { config } = await this.mutate((raw, current) => {
      if (current.instances.length >= current.management.maxInstances) {
        throw new Error(`QQ 实例已达到上限（${current.management.maxInstances}）`);
      }
      if (current.instances.some(instance => instance.id === normalizedUin || instance.uin === normalizedUin)) {
        throw new Error(`QQ ${normalizedUin} 已存在`);
      }

      const root = current.management.instanceRoot;
      const instances = Array.isArray(raw.instances) ? raw.instances : [];
      raw.instances = instances;
      instances.push({
        id: normalizedUin,
        uin: normalizedUin,
        enabled: true,
        autostart: autostart === true,
        homeDir: path.join(root, normalizedUin, 'home'),
        userDataDir: path.join(root, normalizedUin, 'electron'),
        display: current.runtime.xvfb.display,
      });
    });

    return publicInstance(config.instances.find(instance => instance.id === normalizedUin));
  }

  async updateInstance(id, { autostart } = {}) {
    const { config } = await this.mutate((raw, current) => {
      const instances = Array.isArray(raw.instances) ? raw.instances : [];
      const index = current.instances.findIndex(item => item.id === id);
      const instance = instances[index];
      if (!instance) throw new Error(`不存在 QQ 实例：${id}`);
      if (typeof autostart !== 'boolean') throw new Error('autostart 必须是布尔值');
      instance.autostart = autostart;
    });
    return publicInstance(config.instances.find(instance => instance.id === id));
  }

  async removeInstance(id) {
    const { result } = await this.mutate((raw, current) => {
      const index = current.instances.findIndex(instance => instance.id === id);
      if (index < 0) throw new Error(`不存在 QQ 实例：${id}`);
      raw.instances.splice(index, 1);
      return publicInstance(current.instances[index]);
    });
    return result;
  }

  async updateSettings({ newPassword, sessionTtlMinutes, maxInstances } = {}) {
    const { config } = await this.mutate((raw, current) => {
      raw.auth = ensureObject(raw.auth);
      if (newPassword !== undefined && newPassword !== '') {
        raw.auth.password = newPassword;
        delete raw.auth.passwordHash;
      }
      if (sessionTtlMinutes !== undefined) raw.auth.sessionTtlMinutes = sessionTtlMinutes;

      raw.management = ensureObject(raw.management, {
        instanceRoot: current.management.instanceRoot,
      });
      if (maxInstances !== undefined) {
        if (Number.isInteger(maxInstances) && maxInstances < current.instances.length) {
          throw new Error(`最大实例数不能小于当前实例数 ${current.instances.length}`);
        }
        raw.management.maxInstances = maxInstances;
      }
    });
    return publicSettings(config);
  }
}

export { publicSettings };
