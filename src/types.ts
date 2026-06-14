export interface ProjectConfig {
  alias: string;
  path: string;
  gitRemote?: string;
  notifyOnly?: boolean;
  source?: "manual" | "auto";
}

export type AppServerTransportMode = "auto" | "desktop-proxy" | "spawn";
export type AppServerTransportModeUsed = "desktop-proxy" | "spawn" | "none";

export interface AppServerTransportConfig {
  mode: AppServerTransportMode;
  desktopProxySocket: string;
  fallbackToSpawn: boolean;
}

export interface AppServerTransportStatus {
  configuredMode: AppServerTransportMode;
  modeUsed: AppServerTransportModeUsed;
  liveDesktopUpdates: boolean;
  reason: string;
  socketPath?: string;
}

export type WechatRuntimeApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type WechatRuntimeSandbox = "workspace-write" | "danger-full-access";

export interface WechatRuntimeConfig {
  approvalPolicy: WechatRuntimeApprovalPolicy;
  sandbox: WechatRuntimeSandbox;
  networkAccess: boolean;
}

export interface AppConfig {
  ownerSenderId?: string;
  codexBin: string;
  codexAppServerConfigOverrides: string[];
  appServerTransport: AppServerTransportConfig;
  wechatRuntime: WechatRuntimeConfig;
  wechatSecurity: {
    ownerOnly: boolean;
    allowLocalImageSend: boolean;
    autoSendLocalImages: boolean;
    allowedMediaRoots: string[];
  };
  notificationThresholdSeconds: number;
  codexTurnTimeoutMs: number;
  notifyFallbackEnabled: boolean;
  autoDiscoverCodexProjects: boolean;
  projectRoots: string[];
  projects: ProjectConfig[];
  wechatProgress: {
    typingEnabled: boolean;
    typingKeepaliveMs: number;
    heartbeatAfterMs: number;
  };
  wechatApproval: {
    enabled: boolean;
    timeoutMs: number;
  };
  wechat: {
    baseUrl: string;
    channelVersion: string;
  };
}

export interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

export interface WechatMessage {
  seq?: number;
  message_id?: number;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  from_user_id: string;
  to_user_id?: string;
  context_token?: string;
  message_type: number;
  message_state?: number;
  item_list?: Array<{
    type: number;
    msg_id?: string;
    create_time_ms?: number;
    update_time_ms?: number;
    ref_msg?: WechatRefMessage;
    text_item?: { text?: string };
  }>;
}

export interface WechatRefMessage {
  title?: string;
  message_item?: {
    type?: number;
    msg_id?: string;
    ref_msg?: WechatRefMessage;
    text_item?: { text?: string };
  };
}

export interface HookPayload {
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  started_at_ms?: number;
  completed_at_ms?: number;
  [key: string]: unknown;
}

export interface NoticeRecord {
  id: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  cwd?: string;
  projectAlias?: string;
  title: string;
  summary: string;
  body: string;
  createdAt: number;
  durationMs?: number;
  source: "hook" | "notify" | "wechat";
}

export interface ThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
}

export interface TurnResult {
  threadId: string;
  turnId?: string;
  text: string;
  deniedRequests: number;
}

export interface WechatContext {
  senderId: string;
  contextToken: string;
  text: string;
  message?: WechatMessage;
}
