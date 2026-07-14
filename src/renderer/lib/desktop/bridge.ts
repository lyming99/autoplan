import type { AutoplanApi, UpdateStatus } from '../../types';
import type { Subscribe } from '../api/events';

/** Current P00 desktop-bridge operations backed by the Electron preload. */
export const DESKTOP_BRIDGE_OPERATION_KEYS = [
  'pickDirectory',
  'openProjectFolder',
  'openProjectTerminal',
  'openLogFolder',
  'openWorkspaceFile',
  'pickScriptFile',
  'pickTasksJson',
  'getDroppedFilePath',
  'toFileUrl',
  'updateStatus',
  'checkForUpdates',
  'dismissUpdate',
  'setAutoUpdateCheck',
  'openUpdateInstaller',
  'openExternal',
] as const satisfies readonly (keyof AutoplanApi)[];

export type DesktopBridgeOperationKey = (typeof DESKTOP_BRIDGE_OPERATION_KEYS)[number];
export type DesktopBridgeOperations = Pick<AutoplanApi, DesktopBridgeOperationKey>;

export interface DesktopBridgeEvents {
  onUpdateStatus: Subscribe<UpdateStatus>;
}

/** Electron-native capabilities kept outside the transport-neutral business API. */
export interface DesktopBridge extends DesktopBridgeOperations, DesktopBridgeEvents {}

export type SidecarLifecycleState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';

export interface SidecarLifecycleStatus {
  state: SidecarLifecycleState;
  ready: boolean;
  error?: string;
}

/**
 * Planned extension contract only. It is deliberately not part of DesktopBridge
 * until Electron exposes real app-version and sidecar-supervisor implementations.
 */
export interface DesktopBridgeExtensions {
  getAppVersion: () => Promise<string>;
  sidecar: {
    status: () => Promise<SidecarLifecycleStatus>;
    start: () => Promise<SidecarLifecycleStatus>;
    stop: () => Promise<SidecarLifecycleStatus>;
  };
}
