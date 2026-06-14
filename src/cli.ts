#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { addProjectRoot, configPath, ensureConfig, loadConfig, removeProject, removeProjectRoot, saveConfig, setProjectRoots, upsertProject } from "./config.js";
import type { AppConfig, WechatRuntimeConfig } from "./types.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "help":
      console.log(help());
      return;
    case "doctor":
      await doctorCommand();
      return;
    case "start": {
      const { startDaemon } = await import("./daemon.js");
      await startDaemon();
      return;
    }
    case "setup":
      await setup();
      return;
    case "configure":
      await configure();
      return;
    case "bind-owner":
      await bindOwner();
      return;
    case "project":
      projectCommand(args);
      return;
    case "project-root":
      projectRootCommand(args);
      return;
    case "allow":
      await allowCommand(args);
      return;
    case "hook":
      await hookCommand(args);
      return;
    case "desktop":
      await desktopCommand(args);
      return;
    case "transport":
      await transportCommand(args);
      return;
    case "runtime":
      runtimeCommand(args);
      return;
    case "hook-post":
      await hookPost();
      return;
    case "service":
      await serviceCommand(args);
      return;
    case "watchdog":
      await watchdogCommand(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function doctorCommand(): Promise<void> {
  const { doctor } = await import("./doctor.js");
  console.log(doctor());
}

async function setup(): Promise<void> {
  const config = ensureConfig();
  const { loginWithQr } = await import("./wechat.js");
  const account = await loginWithQr(config, (qr) => {
    console.log("请用微信扫描以下二维码：\n");
    console.log(qr);
    console.log();
    void printQr(qr);
  });
  console.log(`微信登录成功：${account.accountId}`);
  console.log("下一步：运行 bind-owner 绑定 owner，然后运行 configure 配置项目根目录和完成通知 hook。");
}

async function configure(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let config = ensureConfig();
  try {
    console.log(`配置文件：${configPath()}`);
    const codexBin = resolveCodexBin(config.codexBin);
    if (codexBin !== config.codexBin) {
      config = { ...config, codexBin };
      console.log(`Codex binary：${codexBin}`);
    }

    const rootsInput = await rl.question(`项目根目录，用逗号分隔。当前：${config.projectRoots.join(", ")}\n> `);
    if (rootsInput.trim()) config = setProjectRoots(config, splitListInput(rootsInput));

    const autoDiscover = await askYesNo(rl, `是否自动把项目根目录下的一级目录生成为微信项目？`, config.autoDiscoverCodexProjects);
    config = { ...config, autoDiscoverCodexProjects: autoDiscover };

    const thresholdInput = await rl.question(`外部 Codex turn 超过多少秒才通知？当前：${config.notificationThresholdSeconds}，输入 0 表示每次都通知\n> `);
    if (thresholdInput.trim()) {
      const threshold = Number(thresholdInput.trim());
      if (!Number.isFinite(threshold) || threshold < 0) throw new Error("通知阈值必须是非负数字。");
      config = { ...config, notificationThresholdSeconds: threshold };
    }

    config = await configureWechatRuntime(rl, config);

    saveConfig(config, { persistWechatRuntime: true });
    console.log("项目与通知配置已保存。");

    const { desktopHookReadiness, hookStatus, installHook, installLaunchdService, restartCodexDesktop, trustInstalledHook } = await import("./hook.js");
    const hook = hookStatus();
    const shouldInstallHook = await askYesNo(rl, hook.installed ? "Stop hook 已安装。是否重新安装/刷新？" : "是否现在安装 Codex Stop hook，用于 Desktop/CLI 完成通知？", !hook.installed);
    if (shouldInstallHook) {
      installHook();
      const trust = await trustInstalledHook();
      console.log(`Stop hook 已写入并全局信任：${trust.trustStatus} ${trust.currentHash}`);
      const readiness = desktopHookReadiness();
      console.log(`Desktop hook 状态：${readiness.status}。${readiness.reason}`);
      if (readiness.status === "restart-recommended") {
        const restart = await askYesNo(rl, "检测到 Codex Desktop 早于 hook 配置启动。是否现在重启 Codex Desktop 以保证完成通知生效？", true);
        if (restart) {
          await restartCodexDesktop();
          console.log("Codex Desktop 已重启。");
        } else {
          console.log("已跳过 Desktop 重启；重启前 Desktop 完成通知可能不会触发微信通知。");
        }
      }
    } else {
      console.log("已跳过 hook 安装。之后可运行：wechat-codex hook install");
    }

    const shouldInstallService = await askYesNo(rl, "是否生成 macOS launchd 后台服务配置？", false);
    if (shouldInstallService) {
      const result = installLaunchdService("com.codex.wechat");
      console.log(`后台服务配置：${result.plistPath}`);
      console.log(`后台服务加载：${result.loaded ? "ok" : `failed (${result.detail})`}`);
      const { installWatchdogService } = await import("./watchdog.js");
      const watchdog = installWatchdogService();
      console.log(`watchdog 配置：${watchdog.plistPath}`);
      console.log(`watchdog 加载：${watchdog.loaded ? "ok" : `failed (${watchdog.detail})`}`);
    }

    console.log("配置完成。建议运行：wechat-codex doctor");
  } finally {
    rl.close();
  }
}

async function printQr(qr: string): Promise<void> {
  try {
    const qrterm = (await import("qrcode-terminal")) as unknown as {
      default?: { generate: (input: string, options: { small: boolean }) => void };
      generate?: (input: string, options: { small: boolean }) => void;
    };
    const generate = qrterm.default?.generate || qrterm.generate;
    if (generate) {
      generate(qr, { small: true });
      return;
    }
  } catch {
    // Fall back to raw content below.
  }
  console.log(qr);
}

async function bindOwner(): Promise<void> {
  const config = ensureConfig();
  const { loadAccount, monitorWechat, extractText, sendLongText } = await import("./wechat.js");
  const { StateStore } = await import("./state.js");
  const account = loadAccount();
  if (!account) throw new Error("未找到微信登录信息，请先运行 setup。");
  const store = new StateStore();
  const code = `bind-${Math.random().toString(16).slice(2, 8)}`;
  console.log(`请在微信里给 ClawBot 发送：${code}`);
  console.log("等待消息中，8 分钟后超时。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  try {
    await new Promise<void>((resolve, reject) => {
      monitorWechat(
        config,
        account,
        async (message) => {
          const text = extractText(message);
          if (!text.includes(code)) return;
          const senderId = message.from_user_id;
          if (!message.context_token) throw new Error("绑定消息缺少 context_token，请再发一次验证码。");
          store.upsertContextToken(senderId, message.context_token);
          store.addAllowed(senderId, senderId.split("@")[0], true);
          saveConfig({ ...config, ownerSenderId: senderId });
          await sendLongText(config, account, senderId, "微信 Codex 助手已绑定这个微信账号。", message.context_token);
          controller.abort();
          resolve();
        },
        controller.signal,
      ).catch((error) => {
        if (controller.signal.aborted) resolve();
        else reject(error);
      });
    });
  } finally {
    clearTimeout(timeout);
    store.close();
  }
  console.log("owner 绑定完成。");
}

function projectCommand(args: string[]): void {
  const sub = args[0];
  const config = ensureConfig();
  if (sub === "list") {
    console.log(config.projects.map((p) => `${p.alias}\t${p.path}\t${p.source || "manual"}\t${p.notifyOnly ? "notifyOnly" : ""}`).join("\n") || "No projects");
    return;
  }
  if (sub === "add") {
    const [, alias, projectPath, ...rest] = args;
    if (!alias || !projectPath) throw new Error("Usage: project add <alias> <path> [--notify-only]");
    saveConfig(upsertProject(config, { alias, path: projectPath, notifyOnly: rest.includes("--notify-only") }));
    console.log(`Saved project ${alias} in ${configPath()}`);
    return;
  }
  if (sub === "remove") {
    const alias = args[1];
    if (!alias) throw new Error("Usage: project remove <alias>");
    saveConfig(removeProject(config, alias));
    console.log(`Removed project ${alias}`);
    return;
  }
  throw new Error("Usage: project list|add|remove");
}

function projectRootCommand(args: string[]): void {
  const sub = args[0];
  const config = ensureConfig();
  if (sub === "list") {
    console.log(config.projectRoots.join("\n") || "No project roots");
    return;
  }
  if (sub === "add") {
    const root = args[1];
    if (!root) throw new Error("Usage: project-root add <path>");
    saveConfig(addProjectRoot(config, root));
    console.log(`Added project root ${root}`);
    return;
  }
  if (sub === "remove") {
    const root = args[1];
    if (!root) throw new Error("Usage: project-root remove <path>");
    saveConfig(removeProjectRoot(config, root));
    console.log(`Removed project root ${root}`);
    return;
  }
  if (sub === "set") {
    const roots = args.slice(1);
    if (!roots.length) throw new Error("Usage: project-root set <path> [path...]");
    saveConfig(setProjectRoots(config, roots));
    console.log(`Saved ${roots.length} project root(s)`);
    return;
  }
  if (sub === "enable" || sub === "disable") {
    saveConfig({ ...config, autoDiscoverCodexProjects: sub === "enable" });
    console.log(`Auto discovery ${sub === "enable" ? "enabled" : "disabled"}`);
    return;
  }
  throw new Error("Usage: project-root list|add|remove|set|enable|disable");
}

async function allowCommand(args: string[]): Promise<void> {
  const { StateStore } = await import("./state.js");
  const store = new StateStore();
  const sub = args[0];
  if (sub === "list") {
    console.log(store.listAllowed().map((a) => `${a.senderId}\t${a.nickname || ""}\t${a.isOwner ? "owner" : ""}`).join("\n") || "No allowed users");
    store.close();
    return;
  }
  if (sub === "add") {
    const senderId = args[1];
    if (!senderId) throw new Error("Usage: allow add <senderId> [nickname] [--owner]");
    store.addAllowed(senderId, args[2]?.startsWith("--") ? undefined : args[2], args.includes("--owner"));
    console.log(`Allowed ${senderId}`);
    store.close();
    return;
  }
  throw new Error("Usage: allow list|add");
}

async function hookCommand(args: string[]): Promise<void> {
  const { desktopHookReadiness, hookStatus, installHook, trustInstalledHook, uninstallHook } = await import("./hook.js");
  const sub = args[0] || "status";
  if (sub === "install") {
    installHook();
    if (!args.includes("--no-trust")) {
      const trust = await trustInstalledHook();
      console.log(`Hook installed and globally trusted: ${trust.trustStatus} ${trust.currentHash}`);
    } else {
      console.log("Hook installed. Open Codex /hooks and trust the new hook if prompted.");
    }
    const readiness = desktopHookReadiness();
    if (readiness.status === "restart-recommended") {
      console.log(`Desktop restart recommended: ${readiness.reason}`);
      console.log("Run: wechat-codex desktop restart");
    }
    return;
  }
  if (sub === "trust") {
    const trust = await trustInstalledHook();
    console.log(`Hook globally trusted: ${trust.trustStatus} ${trust.currentHash}`);
    return;
  }
  if (sub === "uninstall") {
    uninstallHook();
    console.log("Hook removed.");
    return;
  }
  if (sub === "status") {
    console.log(JSON.stringify({ ...hookStatus(), desktop: desktopHookReadiness() }, null, 2));
    return;
  }
  throw new Error("Usage: hook install [--no-trust]|trust|uninstall|status");
}

async function desktopCommand(args: string[]): Promise<void> {
  const { desktopHookReadiness, restartCodexDesktop } = await import("./hook.js");
  const sub = args[0] || "status";
  if (sub === "status") {
    console.log(JSON.stringify(desktopHookReadiness(), null, 2));
    return;
  }
  if (sub === "restart") {
    await restartCodexDesktop();
    console.log("Codex Desktop restarted.");
    return;
  }
  throw new Error("Usage: desktop status|restart");
}

async function transportCommand(args: string[]): Promise<void> {
  const { desktopLiveUpdateDoctorStatus, inspectAppServerTransport } = await import("./codex-client.js");
  const sub = args[0] || "status";
  if (sub === "status") {
    const status = inspectAppServerTransport(loadConfig());
    console.log(JSON.stringify({ desktopLiveUpdate: desktopLiveUpdateDoctorStatus(status), ...status }, null, 2));
    return;
  }
  throw new Error("Usage: transport status");
}

function runtimeCommand(args: string[]): void {
  const config = ensureConfig();
  const sub = args[0] || "status";
  if (sub === "status") {
    console.log(JSON.stringify(config.wechatRuntime, null, 2));
    return;
  }
  if (sub === "safe") {
    saveConfig({
      ...config,
      wechatRuntime: safeRuntime(),
    }, { persistWechatRuntime: true });
    console.log("WeChat runtime set to workspace-write + on-request.");
    return;
  }
  if (sub === "full-access") {
    saveConfig({
      ...config,
      wechatRuntime: fullAccessRuntime(),
    }, { persistWechatRuntime: true });
    console.log("WeChat runtime set to danger-full-access + never. Restart the service to apply.");
    return;
  }
  throw new Error("Usage: runtime status|safe|full-access");
}

async function configureWechatRuntime(rl: ReturnType<typeof createInterface>, config: AppConfig): Promise<AppConfig> {
  const current = runtimeLabel(config.wechatRuntime);
  console.log(`当前微信远程运行权限：${current}`);
  if (config.wechatRuntime.sandbox === "danger-full-access" && config.wechatRuntime.approvalPolicy === "never") {
    console.log("警告：当前配置允许 owner 微信账号远程触发 danger-full-access + never 的 Codex turn。");
  }
  const answer = (
    await rl.question(
      [
        "请选择微信远程运行权限：",
        "- safe：workspace-write + on-request（推荐开源默认）",
        "- inherit：继续继承/使用当前 Codex 配置",
        "- full-access：danger-full-access + never（高风险）",
        `当前：${current}`,
        "> ",
      ].join("\n"),
    )
  )
    .trim()
    .toLowerCase();
  if (!answer || answer === "inherit") {
    if (config.wechatRuntime.sandbox === "danger-full-access" && config.wechatRuntime.approvalPolicy === "never") {
      const keep = await askYesNo(rl, "确认保留微信远程 full-access + never？", false);
      return keep ? config : { ...config, wechatRuntime: safeRuntime() };
    }
    return config;
  }
  if (answer === "safe") return { ...config, wechatRuntime: safeRuntime() };
  if (answer === "full-access" || answer === "full") {
    const confirm = await rl.question('高风险确认：请输入 "I understand" 继续启用 full-access\n> ');
    if (confirm.trim() !== "I understand") throw new Error("已取消 full-access 配置。");
    return { ...config, wechatRuntime: fullAccessRuntime() };
  }
  throw new Error(`无法识别的运行权限选择：${answer}`);
}

function safeRuntime(): WechatRuntimeConfig {
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    networkAccess: false,
  };
}

function fullAccessRuntime(): WechatRuntimeConfig {
  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  };
}

function runtimeLabel(runtime: WechatRuntimeConfig): string {
  return `sandbox=${runtime.sandbox} approval=${runtime.approvalPolicy} network=${runtime.networkAccess}`;
}

async function hookPost(): Promise<void> {
  const { parseHookPayload, postHookPayload } = await import("./hook.js");
  const raw = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
  await postHookPayload(parseHookPayload(raw));
}

async function serviceCommand(args: string[]): Promise<void> {
  const { installLaunchdService, serviceStatus, uninstallLaunchdService } = await import("./hook.js");
  const { installWatchdogService, uninstallWatchdogService } = await import("./watchdog.js");
  const sub = args[0] || "status";
  if (sub === "install") {
    const result = installLaunchdService("com.codex.wechat");
    console.log(`Wrote ${result.plistPath}`);
    console.log(result.loaded ? "Service loaded." : `Service not loaded: ${result.detail}`);
    const watchdog = installWatchdogService();
    console.log(`Wrote ${watchdog.plistPath}`);
    console.log(watchdog.loaded ? "Watchdog loaded." : `Watchdog not loaded: ${watchdog.detail}`);
    return;
  }
  if (sub === "uninstall") {
    uninstallLaunchdService("com.codex.wechat");
    uninstallWatchdogService();
    console.log("Service removed.");
    return;
  }
  if (sub === "status") {
    const status = serviceStatus("com.codex.wechat");
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  throw new Error("Usage: service install|uninstall|status");
}

async function watchdogCommand(args: string[]): Promise<void> {
  const { installWatchdogService, runWatchdog, uninstallWatchdogService, watchdogStatus } = await import("./watchdog.js");
  const sub = args[0] || "status";
  if (sub === "run") {
    console.log(JSON.stringify(runWatchdog(), null, 2));
    return;
  }
  if (sub === "install") {
    const result = installWatchdogService();
    console.log(`Wrote ${result.plistPath}`);
    console.log(result.loaded ? "Watchdog loaded." : `Watchdog not loaded: ${result.detail}`);
    return;
  }
  if (sub === "uninstall") {
    uninstallWatchdogService();
    console.log("Watchdog removed.");
    return;
  }
  if (sub === "status") {
    console.log(JSON.stringify(watchdogStatus(), null, 2));
    return;
  }
  throw new Error("Usage: watchdog install|uninstall|status|run");
}

function help(): string {
  return `wechat-codex

Commands:
  setup                         QR login with WeChat iLink
  configure                     guided setup for project roots, hook and service
  bind-owner                    bind the next WeChat message containing a one-time code as owner
  start                         start local daemon
  doctor                        inspect local readiness
  project-root list|add|remove|set|enable|disable
  project list
  project add <alias> <path> [--notify-only]
  project remove <alias>
  allow list
  allow add <senderId> [nickname] [--owner]
  hook install [--no-trust]|trust|uninstall|status
  desktop status|restart
  transport status
  runtime status|safe|full-access
  service install|uninstall|status
  watchdog install|uninstall|status|run
  hook-post                     internal command used by Codex Stop hook
`;
}

function splitListInput(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveCodexBin(current: string): string {
  if (current.startsWith("/") && current.length > 1) return current;
  try {
    return execFileSync("which", [current || "codex"], { encoding: "utf8" }).trim() || current;
  } catch {
    return current;
  }
}

async function askYesNo(rl: ReturnType<typeof createInterface>, question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${question}${suffix}\n> `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  if (["y", "yes", "是"].includes(answer)) return true;
  if (["n", "no", "否"].includes(answer)) return false;
  throw new Error(`无法识别的是/否输入：${answer}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
