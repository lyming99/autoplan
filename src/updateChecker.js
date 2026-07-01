'use strict';

/**
 * 正式版本更新检查核心模块（需求 #24）。
 *
 * 职责拆分：
 * - 纯解析层（不触网，便于单测）：parseVersion / compareVersions / parseLatestRelease / hasStableUpdate。
 * - 抓取与调度层（依赖注入 app/net/db）：createUpdateChecker，负责请求 GitHub releases/latest、
 *   持久化 update.* 设置、周期调度与并发安全。
 *
 * 设计要点：抓取与解析解耦；网络异常/超时/非 2xx/JSON 解析失败一律返回结构化 { ok:false, error }，
 * 不抛崩、不影响 GUI；仅提醒不自动安装（避免与三端签名/公证冲突）。
 */

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_REPO = 'lyming99/autoplan';
const DEFAULT_INTERVAL_MINUTES = 360;
const GITHUB_ACCEPT = 'application/vnd.github+json';

// 严格 semver 主版本号/修订号/补丁号，可选 prerelease（点分标识符），可选 build 元数据（忽略）。
// 调用前已剥离前导 v/V/=，故此处从 major 起匹配。
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// prerelease 纯数字标识符：无前导零的 0 或正整数（semver §9）。
const NUMERIC_ID_RE = /^(0|[1-9]\d*)$/;

/**
 * 解析版本号为结构化对象。
 * 兼容 `v0.2.2`、`0.2.1-beta.6`、无前缀、含 build 元数据等输入。
 * @param {string|*} tag
 * @returns {{major:number,minor:number,patch:number,prerelease:string[]}|null} 非法输入返回 null，绝不抛错。
 */
function parseVersion(tag) {
  if (tag === null || tag === undefined) return null;
  const raw = String(tag).trim().replace(/^[vV=]+/, '');
  const match = VERSION_RE.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * 比较 A 与 B（可为版本字符串或已解析对象）的语义版本先后。
 * @returns {-1|0|1} A<B 返回 -1，相等 0，A>B 返回 1。任一不可解析返回 0（保守视为相等，不误报更新）。
 *
 * prerelease 段遵循 semver §11：有 prerelease 者优先级低于同号稳定版（`0.2.1-beta.6 < 0.2.1`），
 * 纯数字标识符按数值比较，数字标识符低于字母标识符，更长前置相等的 prerelease 列表优先级更高。
 */
function compareVersions(a, b) {
  const pa = toParsed(a);
  const pb = toParsed(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * 从 GitHub Release JSON 提取正式版判定所需字段。
 * `version` 去 tag 前导 v；`draft`/`prerelease=true` 标记为非正式版（isStable=false）。
 * @param {*} json
 * @returns {{version:string,name:string,htmlUrl:string,publishedAt:string,body:string,summary:string,isPrerelease:boolean,isDraft:boolean,isStable:boolean}|null}
 */
function parseLatestRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const tag = String(json.tag_name || '').trim();
  if (!tag) return null;
  const prerelease = json.prerelease === true;
  const draft = json.draft === true;
  const body = typeof json.body === 'string' ? json.body : '';
  return {
    version: stripLeadingV(tag),
    name: String(json.name || tag || '').trim(),
    htmlUrl: String(json.html_url || '').trim(),
    publishedAt: String(json.published_at || '').trim(),
    body,
    summary: summarizeBody(body),
    isPrerelease: prerelease,
    isDraft: draft,
    isStable: !prerelease && !draft,
  };
}

/**
 * 仅当 release 为非 prerelease、非 draft 且版本号严格大于本地版本时返回 true。
 * 保证「beta → 同号稳定版」视为有更新。
 * @param {string} currentVersion
 * @param {*} release parseLatestRelease 产物或等价对象
 * @returns {boolean}
 */
function hasStableUpdate(currentVersion, release) {
  if (!releaseIsStable(release)) return false;
  const current = parseVersion(currentVersion);
  const latest = parseVersion(release.version);
  if (!current || !latest) return false;
  return compareVersions(latest, current) > 0;
}

/**
 * 创建更新检查器实例（依赖注入以便单测）。
 * @param {{app?:{getVersion?:Function}, net?:{request?:Function}, db?:object, repo?:string, fetch?:Function}} opts
 */
function createUpdateChecker(opts = {}) {
  const { app, net, db, repo, fetch, onCheck } = opts;
  const repoSlug = repo || DEFAULT_REPO;

  let inflight = null; // 进行中的检查 Promise，重复触发直接复用，避免并发重复请求
  const timer = { handle: null };

  function localVersion() {
    return typeof app?.getVersion === 'function' ? String(app.getVersion() || '0.0.0') : '0.0.0';
  }

  function userAgent() {
    return `autoplan/${localVersion()}`;
  }

  function readSetting(key, fallback) {
    return db && typeof db.getSetting === 'function' ? db.getSetting(key, fallback) : fallback;
  }

  function writeSetting(key, value) {
    if (db && typeof db.setSetting === 'function') db.setSetting(key, value);
  }

  function autoCheckEnabled() {
    // 默认开启：仅在显式 'false' 时关闭。
    return readSetting('update.autoCheck', 'true') !== 'false';
  }

  function intervalMinutes() {
    const value = Number(readSetting('update.intervalMinutes', String(DEFAULT_INTERVAL_MINUTES)));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MINUTES;
  }

  /**
   * 触发一次检查（并发安全：进行中则复用同一 Promise）。
   * 成功持久化 update.lastCheckedAt 与最新正式版缓存；失败返回结构化错误。
   * @returns {Promise<object>} 始终 resolve，含 ok/error 及 status() 快照。
   */
  function check() {
    if (inflight) return inflight; // 进行中则复用同一 Promise，避免并发重复请求
    const run = async () => {
      let head;
      try {
        const json = await fetchLatestRelease();
        const release = parseLatestRelease(json);
        persistAfterCheck(release);
        head = { ok: true, error: null, release: release || null };
      } catch (error) {
        head = { ok: false, error: errorMessage(error), release: null };
      }
      const result = { ...head, ...status() };
      // 检查完成回调（主进程据此向渲染进程推送 updates:status），覆盖手动与周期检查。
      if (typeof onCheck === 'function') {
        try {
          onCheck(result);
        } catch {
          /* 回调异常不影响检查结果 */
        }
      }
      return result;
    };
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function persistAfterCheck(release) {
    writeSetting('update.lastCheckedAt', nowIsoSafe());
    if (release && release.version) {
      writeSetting('update.latestVersion', release.version);
      writeSetting('update.latestVersionName', release.name || '');
      writeSetting('update.latestHtmlUrl', release.htmlUrl || '');
      writeSetting('update.latestPublishedAt', release.publishedAt || '');
      writeSetting('update.latestIsPrerelease', String(release.isPrerelease === true));
    }
  }

  async function fetchLatestRelease() {
    const url = `https://api.github.com/repos/${repoSlug}/releases/latest`;
    if (typeof fetch === 'function') return fetchWithInjected(fetch, url);
    return fetchWithNet(net, url);
  }

  // 注入式 fetch（单测用）：复用 fetch API 形态，带超时中止。
  async function fetchWithInjected(fetchFn, url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        /* 超时中止为尽力而为 */
      }
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { 'User-Agent': userAgent(), Accept: GITHUB_ACCEPT },
        signal: controller?.signal,
      });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
      const text = await response.text();
      return JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }
  }

  // 生产路径：Electron net.request，正确复用系统代理，带 User-Agent/Accept 头与超时中止。
  function fetchWithNet(netModule, url) {
    return new Promise((resolve, reject) => {
      if (!netModule || typeof netModule.request !== 'function') {
        reject(new Error('network unavailable'));
        return;
      }
      let request;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          request?.abort();
        } catch {
          /* 忽略中止异常 */
        }
        reject(new Error('request timeout'));
      }, REQUEST_TIMEOUT_MS);
      try {
        request = netModule.request({ url, method: 'GET', redirect: 'follow' });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      request.setHeader('User-Agent', userAgent());
      request.setHeader('Accept', GITHUB_ACCEPT);
      const chunks = [];
      request.on('response', (response) => {
        const status = response.statusCode;
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const body = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('invalid JSON'));
          }
        });
        response.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      try {
        request.end();
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 拼装当前状态：当前版本、最新正式版、是否有更新（已扣除已忽略版本）、上次检查时间、autoCheck、html_url 等。
   * @returns {object}
   */
  function status() {
    const settings = db && typeof db.getSettings === 'function' ? db.getSettings('update.') : {};
    const currentVersion = localVersion();
    const latestVersion = settings['update.latestVersion'] || '';
    const latestName = settings['update.latestVersionName'] || '';
    const htmlUrl = settings['update.latestHtmlUrl'] || '';
    const publishedAt = settings['update.latestPublishedAt'] || '';
    const dismissedVersion = settings['update.dismissedVersion'] || '';
    const latestRelease = latestVersion
      ? { version: latestVersion, isPrerelease: settings['update.latestIsPrerelease'] === 'true' }
      : null;
    const stableUpdate = latestRelease ? hasStableUpdate(currentVersion, latestRelease) : false;
    const hasUpdate = stableUpdate && latestVersion !== dismissedVersion;
    return {
      currentVersion,
      latestVersion,
      latestName,
      htmlUrl,
      publishedAt,
      lastCheckedAt: settings['update.lastCheckedAt'] || '',
      dismissedVersion,
      hasUpdate,
      stableUpdate,
      autoCheck: settings['update.autoCheck'] !== 'false',
      intervalMinutes: Number(settings['update.intervalMinutes'] || DEFAULT_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES,
    };
  }

  /** 忽略指定版本（写 update.dismissedVersion）；缺省取当前最新正式版。本轮不再弹横幅。 */
  function dismiss(input) {
    const version = resolveVersionInput(input) || readSetting('update.latestVersion', '') || '';
    if (version) writeSetting('update.dismissedVersion', version);
    return status();
  }

  /** 切换自动检查并即时重排调度。 */
  function setAutoCheck(enabled) {
    const value = isFalsyEnabled(enabled) ? 'false' : 'true';
    writeSetting('update.autoCheck', value);
    reschedule();
    return status();
  }

  /** 启动周期调度（autoCheck 关闭时不启动定时器）。 */
  function start() {
    reschedule();
  }

  /** 停止调度，清理定时器。 */
  function stop() {
    clearTimer();
  }

  function reschedule() {
    clearTimer();
    if (!autoCheckEnabled()) return;
    const delay = intervalMinutes() * 60 * 1000;
    timer.handle = setTimeout(() => {
      timer.handle = null;
      check().catch(() => {
        /* 检查失败已在结果中结构化，调度不中断 */
      });
      reschedule();
    }, delay);
    // Node 定时器不阻止退出；应用退出时由 stop() 显式清理。
    if (timer.handle && typeof timer.handle.unref === 'function') timer.handle.unref();
  }

  function clearTimer() {
    if (timer.handle) {
      clearTimeout(timer.handle);
      timer.handle = null;
    }
  }

  return { check, status, dismiss, setAutoCheck, start, stop };
}

/* ---------------------------------- 内部纯函数 ---------------------------------- */

function toParsed(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return parseVersion(input);
  if (typeof input === 'object') {
    if (typeof input.version === 'string') return parseVersion(input.version);
    if (Number.isInteger(input.major) && Number.isInteger(input.minor) && Number.isInteger(input.patch)) {
      return {
        major: input.major,
        minor: input.minor,
        patch: input.patch,
        prerelease: Array.isArray(input.prerelease) ? input.prerelease.map(String) : [],
      };
    }
  }
  return null;
}

function comparePrerelease(a, b) {
  const aHas = a.length > 0;
  const bHas = b.length > 0;
  if (!aHas && !bHas) return 0;
  // 无 prerelease（稳定版）优先级高于有 prerelease：`0.2.1-beta.6 < 0.2.1`。
  if (!aHas) return 1;
  if (!bHas) return -1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // 前置相等时更短的 prerelease 列表优先级更低
    if (bi === undefined) return 1;
    const aNum = NUMERIC_ID_RE.test(ai);
    const bNum = NUMERIC_ID_RE.test(bi);
    if (aNum && !bNum) return -1; // 纯数字标识符优先级低于字母标识符
    if (!aNum && bNum) return 1;
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (ai < bi) return -1;
    else if (ai > bi) return 1;
  }
  return 0;
}

function releaseIsStable(release) {
  if (!release) return false;
  if (release.isStable === false) return false;
  if (release.isStable === true) return true;
  if (release.isPrerelease === true || release.isDraft === true) return false;
  return true;
}

function stripLeadingV(value) {
  return String(value || '').trim().replace(/^[vV=]+/, '');
}

function summarizeBody(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const MAX = 280;
  return text.length > MAX ? `${text.slice(0, MAX).trimEnd()}…` : text;
}

function resolveVersionInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input === 'object' && typeof input.version === 'string') return input.version.trim();
  return '';
}

function isFalsyEnabled(enabled) {
  return enabled === false || enabled === 'false' || enabled === 0 || enabled === '0' || enabled === 'off';
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  return String(error.message || error);
}

function nowIsoSafe() {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

module.exports = {
  parseVersion,
  compareVersions,
  parseLatestRelease,
  hasStableUpdate,
  createUpdateChecker,
};
