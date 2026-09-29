import path from "node:path";
import { redactSecrets } from "./runtime.js";

const SENSITIVE_TEXT = /(?:authorization|bearer\s+|cookie|password|passwd|refresh[_ -]?token|access[_ -]?token|api[_ -]?key|secret)/i;

function safeText(value, max = 96) {
  const text = redactSecrets(String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), max * 2);
  if (!text || SENSITIVE_TEXT.test(text) || text.includes("[REDACTED]")) return null;
  return text.slice(0, max);
}

function publicDomain(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.hostname.slice(0, 120);
  } catch { return null; }
}

function safeFilename(value) {
  const text = String(value ?? "");
  if (!text || SENSITIVE_TEXT.test(text) || /(?:^|[\\/])(?:\.env(?:\..*)?|\.npmrc|\.pypirc|auth\.json|credentials?(?:\.[^\\/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/]*\.(?:pem|p12|pfx|key)|\.ssh|Keychains?)(?:[\\/]|$)/i.test(text)) return null;
  const name = path.basename(text).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && name !== "." && name !== "/" ? name.slice(0, 96) : null;
}

export function safeToolActivityDetail(displayName, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const name = String(displayName ?? "").toLowerCase();
  if (/computer_|观察屏幕|截取屏幕|点击|输入文字|滚动|打开应用|激活应用/.test(name)) return null;
  if (/browser_(?:navigate|open)|open_url|visit_url/.test(name)) return publicDomain(args.url ?? args.uri ?? args.href);
  if (/web_search|notion-search|search/.test(name)) return safeText(args.query ?? args.text ?? args.search);
  if (/get_state|turn_on|turn_off|device|entity/.test(name)) return safeText(args.entity_id ?? args.entityId ?? args.entity ?? args.device);
  if (/file|path|upload|download|文件|路径|目录/.test(name)) return safeFilename(args.path ?? args.file ?? args.filename);
  return null;
}

export function toolActivityMetadata({ wireName, args = {}, sourceHint = null, sourceId = null,
  integrationName = null, displayName = null, mcpMetadata = null } = {}) {
  let sourceType = sourceHint ?? "unknown";
  let resolvedSourceId = sourceId;
  let resolvedIntegration = integrationName;
  let resolvedDisplay = displayName;
  if (mcpMetadata) {
    sourceType = mcpMetadata.sourceType ?? "mcp";
    resolvedSourceId = mcpMetadata.sourceId ?? resolvedSourceId;
    resolvedIntegration = mcpMetadata.integrationName ?? resolvedIntegration;
    resolvedDisplay = mcpMetadata.displayName ?? resolvedDisplay;
  }
  const agentLabels={read_image:"读取图片",read_file:"读取文件",list_directory:"查看目录",search_files:"搜索项目",write_file:"新建文件",apply_patch:"修改代码",run_command:"执行测试或命令",get_process_status:"检查执行状态",read_command_output:"读取执行结果",read_pdf:"读取 PDF",take_screenshot:"截取屏幕"};
  if(agentLabels[wireName]){sourceType="native";resolvedSourceId="local-agent";resolvedIntegration="Companion";resolvedDisplay=agentLabels[wireName];}
  else if (wireName === "web_search") {
    sourceType = "core"; resolvedSourceId = "tavily";
    resolvedIntegration = "Tavily"; resolvedDisplay = "web_search";
  } else if (String(wireName).startsWith("computer_") || String(wireName).startsWith("capabilities_")) {
    sourceType = "native"; resolvedSourceId = String(wireName).startsWith("computer_") ? "cua" : "companion-installer";
    resolvedIntegration = String(wireName).startsWith("computer_") ? "Computer Use" : "Capability Installer";
    const labels={computer_screen_observe:"观察屏幕",computer_screen_screenshot:"截取屏幕",computer_window_list:"查看窗口",computer_window_observe:"观察窗口",computer_mouse_click:"点击",computer_mouse_double_click:"双击",computer_mouse_move:"移动指针",computer_mouse_drag:"拖动",computer_keyboard_type:"输入文字",computer_keyboard_key:"按键",computer_keyboard_hotkey:"快捷键",computer_scroll:"滚动",computer_window_focus:"聚焦窗口",computer_app_launch:"打开应用",computer_app_activate:"激活应用",capabilities_discover:"发现所需能力",capabilities_install:"安装 Computer Use"};
    resolvedDisplay = labels[wireName]??"Computer Use";
  } else if (String(wireName).startsWith("terminal_")) {
    sourceType = "native"; resolvedSourceId = "terminal"; resolvedIntegration = "Terminal";
    const labels={terminal_exec:"执行命令",terminal_session_start:"启动终端会话",terminal_session_write:"写入终端会话",terminal_session_read:"读取终端会话",terminal_session_stop:"停止终端会话"};resolvedDisplay=labels[wireName]??"Terminal";
  } else if (String(wireName).startsWith("fs_")) {
    sourceType = "native"; resolvedSourceId = "filesystem"; resolvedIntegration = "Filesystem";
    const labels={fs_read:"读取文件",fs_list:"列出文件",fs_search:"搜索文件",fs_stat:"检查路径",fs_mkdir:"创建目录",fs_write:"写入文件",fs_patch:"修改文件",fs_copy:"复制文件",fs_move:"移动文件",fs_delete:"移至工作区废纸篓"};resolvedDisplay=labels[wireName]??"Filesystem";
  } else if (String(wireName).startsWith("git_")) {
    sourceType="native";resolvedSourceId="git";resolvedIntegration="Git";const labels={git_status:"检查仓库",git_diff:"查看差异",git_log:"查看提交记录",git_branch:"管理分支",git_add:"暂存修改",git_commit:"创建提交",git_push:"推送分支",git_tag:"创建标签",git_stash:"管理临时保存",git_fetch:"获取远端",git_pull:"快进更新"};resolvedDisplay=labels[wireName]??"Git";
  } else if (String(wireName).startsWith("github_")) {
    sourceType="native";resolvedSourceId="github";resolvedIntegration="GitHub";const labels={github_repo_read:"读取仓库",github_issue:"管理 Issue",github_pr:"管理 Pull Request",github_ci_status:"检查 CI",github_release_read:"读取 Release"};resolvedDisplay=labels[wireName]??"GitHub";
  } else if (/^(?:process_|port_inspect|service_health|logs_tail)/.test(String(wireName))) {
    sourceType="native";resolvedSourceId="process";resolvedIntegration=/^(?:service_health|port_inspect|logs_tail)/.test(String(wireName))?"Service":"Process";const labels={process_list:"查看进程",process_inspect:"检查进程",process_start:"启动进程",process_stop:"停止进程",port_inspect:"检查端口",service_health:"服务健康检查",logs_tail:"读取日志"};resolvedDisplay=labels[wireName]??resolvedIntegration;
  } else if (String(wireName).startsWith("self_")) {
    sourceType="native";resolvedSourceId="self-maintenance";resolvedIntegration="Self Maintenance";const labels={self_inspect:"检查自身",self_modify:"修改自身",self_build:"构建自身",self_deploy:"部署 Candidate",self_rollback:"回滚 Candidate"};resolvedDisplay=labels[wireName]??"Self Maintenance";
  } else if (String(wireName).startsWith("package_") || wireName === "release_binary_install") {
    sourceType="native";resolvedSourceId="package-manager";resolvedIntegration="Package Manager";const labels={package_inspect:"检查依赖",package_install:"安装依赖",release_binary_install:"安装 Release 二进制"};resolvedDisplay=labels[wireName]??"Package Manager";
  } else if (!resolvedIntegration && /weather/i.test(String(wireName))) {
    resolvedIntegration = "Weather"; resolvedDisplay = resolvedDisplay ?? String(wireName); sourceType = sourceHint ?? "module";
  } else if (!resolvedIntegration && sourceType === "module") {
    resolvedIntegration = "Module"; resolvedDisplay = resolvedDisplay ?? String(wireName);
  } else if (!resolvedIntegration && sourceType === "core") {
    resolvedIntegration = "Core"; resolvedDisplay = resolvedDisplay ?? String(wireName);
  }
  return {
    source_type: sourceType,
    source_id: resolvedSourceId ?? null,
    integration_name: safeText(resolvedIntegration, 64) ?? "Integration",
    display_name: safeText(resolvedDisplay, 96) ?? "tool",
    detail: safeToolActivityDetail(resolvedDisplay ?? wireName, args)
  };
}

export function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function toolResultFailed(content) {
  return /\[companion tool failure\]|\[(?:mcp|module|tool activity) tool error\]|\[tool activity error\]|tool reported an error|confirmation required|操作失败/i.test(String(content ?? ""));
}

export function classifyToolFailure(content){
  const text=String(content??"");
  const marker=text.match(/\[companion tool failure\]\s*(\{[^\n]+\})/);
  if(marker){try{const value=JSON.parse(marker[1]);return {failure_category:String(value.category??"tool_error").slice(0,48),failure_code:String(value.code??"TOOL_ERROR").slice(0,80),failure_summary:safeText(value.summary,160)??"操作失败",failure_reason:safeText(value.reason,220)};}catch{}}
  const lower=text.toLowerCase();
  if(/entitlement_required|requires notion ai|custom-agent access/.test(lower))return {failure_category:"provider_error",failure_code:"provider_entitlement_required",failure_summary:"服务账号未开通此功能",failure_reason:"当前服务套餐或账号权限不包含这个功能"};
  if(/not connected|oauth|authentication|unauthori[sz]ed/.test(lower))return {failure_category:"not_configured",failure_code:"integration_not_connected",failure_summary:"集成尚未连接或授权已失效",failure_reason:"请先在 Capabilities 中检查集成连接状态"};
  if(toolResultFailed(text))return {failure_category:"tool_error",failure_code:"tool_execution_failed",failure_summary:"服务调用失败",failure_reason:"外部工具返回了错误"};
  return null;
}
