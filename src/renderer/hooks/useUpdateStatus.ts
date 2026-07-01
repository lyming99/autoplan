import { useCallback, useEffect, useState } from 'react';
import type { UpdateCheckResult, UpdateStatus } from '../types';

const EMPTY_STATUS: UpdateStatus = {
  currentVersion: '',
  latestVersion: '',
  latestName: '',
  htmlUrl: '',
  publishedAt: '',
  lastCheckedAt: '',
  dismissedVersion: '',
  hasUpdate: false,
  stableUpdate: false,
  autoCheck: true,
  intervalMinutes: 360,
};

/**
 * 订阅主进程正式版本更新检查状态（需求 #24）。
 * 挂载时调用 updateStatus() 取初值并订阅 onUpdateStatus 推送，卸载时取消订阅。
 * 返回 { status, check, checking }：check 触发一次手动检查，进行中 checking=true。
 * 取初值/推送失败时保持默认空状态，绝不抛出到 UI 打扰用户。
 */
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus>(EMPTY_STATUS);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let active = true;
    window.autoplan
      .updateStatus()
      .then((next) => {
        if (active && next) setStatus(next);
      })
      .catch(() => {
        /* 取初值失败保持默认，不打扰用户 */
      });
    const unsubscribe = window.autoplan.onUpdateStatus((next) => {
      if (active && next) setStatus(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const result: UpdateCheckResult = await window.autoplan.checkForUpdates();
      // check() 结果在 UpdateStatus 字段之外附带 ok/error/release，可直接作为最新状态。
      if (result) setStatus(result);
      return result;
    } catch {
      /* 手动检查失败不抛出到 UI，仅恢复 checking 态 */
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, check, checking };
}
