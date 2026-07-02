import { useEffect, useId, type ReactNode } from 'react';
import { Icon } from './icons';

export interface ModalProps {
  /** 是否可见；为 false 时不渲染到 DOM */
  open: boolean;
  /**
   * 用户请求关闭时回调（头部 ✕ 按钮、Esc 键触发）。
   * 注意：点击 `.modal-mask` 遮罩**不会**触发此回调，避免误操作丢失输入。
   */
  onClose: () => void;
  /** 头部标题，渲染进 `.modal-head` 的 h3 */
  title: ReactNode;
  /** 主体内容，渲染进 `.modal-form`（例如包含字段的 `<form onSubmit>`） */
  children?: ReactNode;
  /** 底部操作区，渲染进 `.modal-foot`（例如「取消 / 保存」按钮） */
  footer?: ReactNode;
  /** 宽度预设：'default' 沿用 `.modal` 的 480px；'wide' 加宽并使主体可纵向滚动（用于长表单） */
  size?: 'default' | 'wide';
  /** 显式 max-width 覆盖（数字按 px，字符串原样），优先级高于 `size` */
  maxWidth?: number | string;
  /** 追加到 `.modal` 外壳的额外类名 */
  className?: string;
  /** 追加到 `.modal-form` 主体的额外类名 */
  bodyClassName?: string;
  /** 关闭按钮的 aria-label */
  closeAriaLabel?: string;
}

/**
 * 共享弹窗外壳（需求 #38）。
 *
 * 统一封装 `.modal-mask` / `.modal` / `.modal-head` / `.modal-form` / `.modal-foot`
 * 结构，供「项目管理」「AI 配置」等表单类弹窗复用，从而天然保证样式一致、避免漂移，
 * 并在组件层一次性落地「点击遮罩不关闭」。
 *
 * 关键行为：
 * - **点击遮罩（`.modal-mask`）不关闭弹窗**：`.modal-mask` 上不绑定关闭 `onClick`，
 *   并在弹窗主体上 `stopPropagation` 以备后续扩展。
 * - 关闭途径仅限：头部 `.modal-close` 按钮、`Esc` 键、footer 内由调用方传入的显式按钮。
 * - `open === false` 时返回 `null`，不渲染到 DOM。
 *
 * 表单提交：当 footer 中的「保存」需触发 children 内的 `<form onSubmit>` 时，给该 form
 * 设置 `id`，并在保存按钮上用 `form="该 id"` 关联（HTML5 `form` 属性，Chromium 支持），
 * 即便按钮位于 form 之外也能正确提交。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'default',
  maxWidth,
  className,
  bodyClassName,
  closeAriaLabel = '关闭',
}: ModalProps) {
  const titleId = useId();

  // Esc 关闭（可选关闭途径之一）。仅在弹窗打开时监听全局 keydown。
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const shellClass = ['modal', size === 'wide' ? 'modal-wide' : '', className]
    .filter(Boolean)
    .join(' ');
  const bodyClass = ['modal-form', bodyClassName].filter(Boolean).join(' ');
  const shellStyle =
    maxWidth != null
      ? { maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth }
      : undefined;

  return (
    <div className="modal-mask">
      <div
        className={shellClass}
        style={shellStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label={closeAriaLabel}>
            <Icon name="close" size={16} aria-hidden="true" />
          </button>
        </div>
        {children != null ? <div className={bodyClass}>{children}</div> : null}
        {footer != null ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
