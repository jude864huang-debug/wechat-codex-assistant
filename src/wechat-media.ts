import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiFetch } from "./wechat.js";
import type { AccountData, AppConfig } from "./types.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_MEDIA_SIZE = 25 * 1024 * 1024;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_IMAGE = 2;
const UPLOAD_MEDIA_IMAGE = 1;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

export interface SentWechatImage {
  clientId: string;
  itemMsgId: string;
  filePath: string;
}

interface UploadedImage {
  encryptQueryParam: string;
  aesKeyHex: string;
  encryptedSize: number;
  rawSize: number;
}

export function isSupportedImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function sendImage(
  config: AppConfig,
  account: AccountData,
  toUserId: string,
  filePath: string,
  contextToken: string,
): Promise<SentWechatImage> {
  const resolved = path.resolve(filePath);
  const uploaded = await uploadImage(config, account, toUserId, resolved);
  const clientId = `wechat-codex:image:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const itemMsgId = clientId;
  const aesKeyBase64 = Buffer.from(uploaded.aesKeyHex).toString("base64");

  await apiFetch(
    { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [
          {
            type: MSG_ITEM_IMAGE,
            msg_id: itemMsgId,
            image_item: {
              media: {
                encrypt_query_param: uploaded.encryptQueryParam,
                aes_key: aesKeyBase64,
                encrypt_type: 1,
              },
              mid_size: uploaded.encryptedSize,
              hd_size: uploaded.encryptedSize,
            },
          },
        ],
        context_token: contextToken,
      },
      base_info: { channel_version: config.wechat.channelVersion },
    },
    account.token,
    15_000,
  );

  return { clientId, itemMsgId, filePath: resolved };
}

export function extractLocalImagePaths(text: string, cwd?: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /!\[[^\]]*]\((file:\/\/)?([^)\s]+?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))\)/gi,
    /(?:file:\/\/)?((?:\/|~\/|\.{1,2}\/)[^\s`'"()[\]{}|<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg|ico))/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = (match[2] || match[1] || "").trim();
      if (!raw) continue;
      const resolved = resolveMentionedPath(raw, cwd);
      if (resolved && isSupportedImagePath(resolved) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        candidates.add(resolved);
      }
    }
  }

  return [...candidates].slice(0, 8);
}

async function uploadImage(config: AppConfig, account: AccountData, toUserId: string, filePath: string): Promise<UploadedImage> {
  if (!isSupportedImagePath(filePath)) throw new Error(`不支持的图片类型：${filePath}`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  if (stat.size > MAX_MEDIA_SIZE) throw new Error(`图片过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`);

  const plaintext = fs.readFileSync(filePath);
  const rawSize = plaintext.length;
  const rawFileMd5 = createHash("md5").update(plaintext).digest("hex");
  const encryptedSize = aesEcbPaddedSize(rawSize);
  const fileKey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  const uploadResp = (await apiFetch(
    { ...config, wechat: { ...config.wechat, baseUrl: account.baseUrl || config.wechat.baseUrl } },
    "ilink/bot/getuploadurl",
    {
      filekey: fileKey,
      media_type: UPLOAD_MEDIA_IMAGE,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: {
        channel_version: "2.0.0",
        bot_agent: "wechat-codex-assistant",
      },
    },
    account.token,
    35_000,
  )) as { upload_param?: string; upload_full_url?: string };

  if (!uploadResp.upload_full_url && !uploadResp.upload_param) throw new Error("获取微信图片上传地址失败");
  const encrypted = encryptAesEcb(aesKey, plaintext);
  const uploadUrl = uploadResp.upload_full_url || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param!)}&filekey=${fileKey}`;
  const encryptQueryParam = await uploadToCdn(uploadUrl, encrypted);
  return { encryptQueryParam, aesKeyHex, encryptedSize, rawSize };
}

async function uploadToCdn(url: string, encrypted: Buffer): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      body: new Uint8Array(encrypted),
      signal: controller.signal,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`微信 CDN 上传失败：${response.status} ${text.slice(0, 200)}`);
    }
    const param = response.headers.get("x-encrypted-param");
    if (!param) throw new Error("微信 CDN 上传成功但未返回 x-encrypted-param");
    return param;
  } finally {
    clearTimeout(timer);
  }
}

function aesEcbPaddedSize(size: number): number {
  const block = 16;
  return Math.floor((size + block - 1) / block) * block;
}

function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function resolveMentionedPath(raw: string, cwd?: string): string | null {
  const decoded = decodeURIComponent(raw.replace(/^file:\/\//, ""));
  if (decoded.startsWith("~/")) return path.join(process.env.HOME || "", decoded.slice(2));
  if (path.isAbsolute(decoded)) return decoded;
  if (cwd && decoded.startsWith(".")) return path.resolve(cwd, decoded);
  return null;
}
