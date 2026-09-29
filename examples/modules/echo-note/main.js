// Echo Note 示例模块。
// 运行环境：Companion Core Trusted Local Module Runtime（node:vm context）。
// 可用能力只有 manifest 声明并通过校验的 companion.* bridge；没有 require/import、
// 没有 fs / child_process / process / 环境变量。

let noteCount = 0;

function onLoad() {
  // 模块被加载后调用一次。
}

function onUnload() {
  // 模块被禁用或重新扫描替换前调用。
}

async function echoNote(args) {
  const text = String((args && args.text) || "").slice(0, 2000);
  noteCount += 1;
  return { note: `ECHO_NOTE:${text}`, count: noteCount };
}

async function manualPing() {
  return { ok: true, ranAt: new Date().toISOString(), notes: noteCount };
}

async function intervalPing() {
  // Trigger handler 可以选择返回 event；Core 会过滤后写入共享 Events。
  return { event: { content: "Echo Note 定时任务已运行", importance: 0.3 } };
}

module.exports = {
  onLoad,
  onUnload,
  tools: {
    mod_echo_note: echoNote
  },
  triggers: {
    manual_ping: manualPing,
    interval_ping: intervalPing
  }
};
