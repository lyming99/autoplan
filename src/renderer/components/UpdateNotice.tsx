import { AUTOPLAN_RELEASES_URL } from '../types';
import { useUpdateStatus } from '../hooks/useUpdateStatus';

/**
 * 全局正式版本更新提醒横幅（需求 #24）。
 * 仅当存在可用正式版更新（status.hasUpdate 已扣除被忽略版本）时渲染；提供「前往下载」
 * （经主进程 shell.openExternal 打开 Release 页面）与「稍后提醒」（写 update.dismissedVersion，
 * 本轮不再提醒）。无更新或检查失败时不打扰用户。
 * 样式复用既有 .inline-banner / .btn，自动适配明暗主题；布局用内联样式微调，不新增 CSS。
 */
export function UpdateNotice() {
  const { status } = useUpdateStatus();
  if (!status.hasUpdate) return null;

  const versionLabel = status.latestVersion ? `v${status.latestVersion}` : '新版本';
  const releaseUrl = status.htmlUrl || AUTOPLAN_RELEASES_URL;

  return (
    <div
      className="inline-banner info update-notice"
      role="status"
      style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}
    >
      <span>
        🆕 检测到新正式版本 <b>{versionLabel}</b> 可用
        {status.latestName ? <span> · {status.latestName}</span> : null}
        {status.publishedAt ? <span> · {status.publishedAt}</span> : null}
      </span>
      <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            void window.autoplan.openExternal(releaseUrl);
          }}
        >
          前往下载
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void window.autoplan.dismissUpdate();
          }}
        >
          稍后提醒
        </button>
      </span>
    </div>
  );
}
