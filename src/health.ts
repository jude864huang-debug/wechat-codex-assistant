import { readJsonFile, statePath, writePrivateFile } from "./paths.js";

export interface DaemonHeartbeat {
  pid: number;
  startedAt: number;
  updatedAt: number;
  lastWechatPollAt?: number;
  lastWechatPollErrorAt?: number;
  lastWechatMessageAt?: number;
  lastHookPayloadAt?: number;
  lastNoticeDeliveredAt?: number;
  lastNoticeErrorAt?: number;
}

export function daemonHeartbeatPath(): string {
  return statePath("daemon-heartbeat.json");
}

export function readDaemonHeartbeat(): DaemonHeartbeat | null {
  return readJsonFile<DaemonHeartbeat>(daemonHeartbeatPath());
}

export function writeDaemonHeartbeat(heartbeat: DaemonHeartbeat): void {
  writePrivateFile(daemonHeartbeatPath(), `${JSON.stringify(heartbeat, null, 2)}\n`);
}

export function heartbeatAgeMs(now = Date.now(), heartbeat = readDaemonHeartbeat()): number | null {
  return heartbeat?.updatedAt ? now - heartbeat.updatedAt : null;
}
