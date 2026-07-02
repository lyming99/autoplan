import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** 侧栏宽度持久化键，与 useTheme/useComposerDrafts 的 `autoplan-*` 风格保持一致。 */
export const SIDEBAR_STORAGE_KEY = 'autoplan.workspaceSidebarWidth';

/** 侧栏宽度下限（px）。 */
export const SIDEBAR_MIN_WIDTH = 200;
/** 侧栏宽度上限（px）。 */
export const SIDEBAR_MAX_WIDTH = 480;
/** 侧栏默认宽度（px），沿用历史固定值 248px。 */
export const SIDEBAR_DEFAULT_WIDTH = 248;

export interface UseSidebarResizeResult {
  /** 当前侧栏宽度（px），始终被 clamp 到区间内。 */
  width: number;
  /** 是否正在拖拽（pointerdown 后、pointerup 前）。 */
  resizing: boolean;
  /** 绑定到拖拽手柄的 pointerdown 处理函数。 */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 复位为默认宽度并落库（双击手柄或主动调用）。 */
  onReset: () => void;
}

interface DragState {
  pointerId: number;
  /** 拖拽起点的水平坐标，用于换算增量。 */
  startX: number;
  /** 拖拽起始时的侧栏宽度，作为增量基准。 */
  startWidth: number;
  /** 拖拽过程中最新计算出的宽度（rAF 节流写状态的取值来源）。 */
  pendingWidth: number;
  /** 当前挂起的 requestAnimationFrame 句柄，null 表示无挂起帧。 */
  rafId: number | null;
  /** 捕获指针的目标元素，监听挂在它上面。 */
  target: HTMLElement;
  onMove: (event: PointerEvent) => void;
  onUp: () => void;
}

/**
 * 将宽度 clamp 到 [min, max] 区间。
 * 非有限值（NaN/±Infinity）回退 min；低于最小取最小、高于最大取最大、合法值原样返回。
 */
export function clampSidebarWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 读取持久化宽度；localStorage 不可用或解析失败时回退默认宽度。 */
function loadSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampSidebarWidth(parsed, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
      }
    }
  } catch {
    /* localStorage 不可用，回退默认宽度 */
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

/** 写入持久化宽度；localStorage 不可用时静默忽略，宽度仅保留在内存中。 */
function persistSidebarWidth(value: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(value));
  } catch {
    /* localStorage 不可用，忽略 */
  }
}

/**
 * 工作区左侧栏拖拽调节尺寸 hook（需求 #39）。
 *
 * 基于 Pointer Events（pointerdown → setPointerCapture → pointermove → pointerup）
 * 实现拖拽，鼠标与触摸均可触发；拖拽过程以 requestAnimationFrame 节流写状态，
 * 避免高频刷新；pointerup 时最终值落库 localStorage。组件卸载时清理监听、释放捕获。
 *
 * 返回 { width, resizing, onPointerDown, onReset }：宽度始终被 clamp 到
 * [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]，默认 SIDEBAR_DEFAULT_WIDTH。
 */
export function useSidebarResize(): UseSidebarResizeResult {
  const [width, setWidth] = useState<number>(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);

  // 拖拽进行中的运行时状态（起点坐标、增量基准、挂起帧等），脱离 React 渲染周期。
  const dragRef = useRef<DragState | null>(null);
  // 让稳定的 onPointerDown 回调始终读到最新宽度，避免把它放进依赖导致函数重建。
  const widthRef = useRef(width);
  widthRef.current = width;

  const endDrag = useCallback(() => {
    const state = dragRef.current;
    if (!state) return;
    dragRef.current = null;

    // 取消挂起帧并同步写出最终宽度，避免与卸载/后续回调竞争。
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    setWidth(state.pendingWidth);
    persistSidebarWidth(state.pendingWidth);

    state.target.removeEventListener('pointermove', state.onMove);
    state.target.removeEventListener('pointerup', state.onUp);
    state.target.removeEventListener('pointercancel', state.onUp);
    try {
      state.target.releasePointerCapture(state.pointerId);
    } catch {
      /* 指针已释放或 ID 失效，忽略 */
    }
    setResizing(false);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // 仅响应主键（鼠标左键）；触摸/手写笔在 pointerdown 时 button 恒为 0。
    if (event.button !== 0) return;

    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* 指针 ID 无效或不可用，忽略捕获失败，仍尝试跟随移动 */
    }

    const startWidth = widthRef.current;
    const state: DragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      pendingWidth: startWidth,
      rafId: null,
      target,
      onMove: (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - state.startX;
        state.pendingWidth = clampSidebarWidth(
          state.startWidth + delta,
          SIDEBAR_MIN_WIDTH,
          SIDEBAR_MAX_WIDTH,
        );
        // 同一帧内只调度一次 rAF，把高频 pointermove 压成每帧至多一次写状态。
        if (state.rafId === null) {
          state.rafId = requestAnimationFrame(() => {
            state.rafId = null;
            setWidth(state.pendingWidth);
          });
        }
      },
      onUp: () => {
        endDrag();
      },
    };
    dragRef.current = state;
    setResizing(true);

    target.addEventListener('pointermove', state.onMove);
    target.addEventListener('pointerup', state.onUp);
    target.addEventListener('pointercancel', state.onUp);
  }, [endDrag]);

  // 组件卸载时若仍在拖拽，确保释放捕获并移除监听，不留悬挂。
  useEffect(() => {
    return () => {
      const state = dragRef.current;
      if (!state) return;
      dragRef.current = null;
      if (state.rafId !== null) cancelAnimationFrame(state.rafId);
      state.target.removeEventListener('pointermove', state.onMove);
      state.target.removeEventListener('pointerup', state.onUp);
      state.target.removeEventListener('pointercancel', state.onUp);
      try {
        state.target.releasePointerCapture(state.pointerId);
      } catch {
        /* noop */
      }
    };
  }, []);

  const onReset = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  return { width, resizing, onPointerDown, onReset };
}
