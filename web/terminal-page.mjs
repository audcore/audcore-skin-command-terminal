import { createTerminalCommands, peakText } from "./terminal-commands.mjs";
import manifest from "./terminal-manifest.json" with { type: "json" };
import { localizeHostError, mountSkin } from "./skin.mjs";
import { mountMeters } from "./meters.mjs";
import { revealNativeCover } from "./startup.mjs";
import { createWebViewAudcore } from "./webview-bridge.mjs";

const local = !window.audcore && window.__AUDCORE_NATIVE_MOCK__
  ? createWebViewAudcore(window.chrome.webview, { visibility: document }) : null;
const preview = null;
const host = window.audcore ?? local ?? preview.host;
const version = new URLSearchParams(window.location?.search).get("hostVersion") ?? "";
const element = id => document.getElementById(id);
const terminal = element("terminal"), input = element("command"), output = element("output"), body = element("channels");
const status = element("status");
const command = createTerminalCommands(host, () => {
  const bounds = input.getBoundingClientRect();
  return { x: bounds.left, y: bounds.top };
});
const labels = {
  zh: ["声核", "运行", "停止", "当前通道", "效果器", "通道", "名称", "增益", "状态", "输出电平",
    "help 查看命令 · ↑↓ 历史 · Tab 补全 · Ctrl+Z/Y 撤销重做", "执行中…", "命令", "模拟数据"],
  en: ["Audcore", "Running", "Stopped", "Channel", "Effect", "Channel", "Name", "Gain", "State", "Output",
    "help for commands · ↑↓ history · Tab complete · Ctrl+Z/Y undo/redo", "Working…", "Command", "Sample data"],
  ja: ["声核", "運転", "停止", "選択", "効果", "通路", "名称", "利得", "状態", "出力",
    "help コマンド · ↑↓ 履歴 · Tab 補完 · Ctrl+Z/Y 取消・再実行", "実行中…", "コマンド", "模擬データ"],
};
const errors = {
  zh: { "command unavailable in this skin": "皮肤不支持此命令", "invalid command; help": "命令格式有误，输入 help 查看",
    "channel unavailable": "通道不存在", "select a channel with use": "请先用 use 选择通道",
    "ambiguous channel; use @ID": "名称重复，请用 @ID", "effect unavailable": "效果器不可用",
    "select an effect with fx use": "请先用 fx use 选择效果器", "unterminated quote": "引号未闭合", "invalid dB": "无效的 dB 数值",
    "use channel add, then name": "请先用 channel add 新建，再用 name 命名",
    "use open or save to choose a file": "请用 open 或 save 打开文件选择窗口",
    "use fx add or the effect menu": "请用 fx add 打开效果器列表，或用 fx menu 打开菜单", "use on or off": "请输入 on 或 off" },
  ja: { "command unavailable in this skin": "このコマンドは非対応です", "invalid command; help": "書式は help で確認できます",
    "channel unavailable": "通路がありません", "select a channel with use": "use で通路を選択",
    "ambiguous channel; use @ID": "同名の通路は @ID で指定", "effect unavailable": "効果を利用できません",
    "select an effect with fx use": "fx use で効果を選択", "unterminated quote": "引用符を閉じてください",
    "invalid dB": "dB の値が無効です", "use channel add, then name": "channel add の後に name で命名",
    "use open or save to choose a file": "open または save でファイルを選択",
    "use fx add or the effect menu": "fx add または fx menu で操作", "use on or off": "on または off を入力" },
};
const promptMessages = {
  zh: ["请将光标移到行尾再补全", "无匹配候选", "请等待上一命令完成"],
  en: ["Move the cursor to the end to complete", "No matches", "Wait for the previous command"],
  ja: ["補完は行末で実行", "候補なし", "前のコマンドを処理中"],
};
const history = [], transcript = [], rows = new Map(), peaks = new Map();
let state = {}, language = "zh", busy = false, composing = false, historyIndex = 0, draft = "";

function focusPrompt() {
  if (document.hidden || document.activeElement === input || document.querySelector('[aria-modal="true"]')) return;
  input.focus({ preventScroll: true });
}

const transcriptSelected = () => window.getSelection()?.isCollapsed === false;

function append(value) {
  const lines = (Array.isArray(value) ? value : [value]).flatMap(item => String(item ?? "").split("\n"));
  transcript.push(...lines);
  if (transcript.length > 4096) transcript.splice(0, transcript.length - 4096);
  output.textContent = transcript.join("\n");
  output.scrollTop = output.scrollHeight;
}

function report(error) {
  const message = error instanceof Error ? error.message : String(error);
  append(errors[language]?.[message] ?? localizeHostError(message, host.i18n.t));
}

function render() {
  const [brand, running, stopped, channelLabel, effectLabel, ...text] = labels[language];
  const audio = state.audio;
  const hostVersion = /^v\d+\.\d+\.\d+$/.test(version) ? version : "—";
  const skinVersion = `v${manifest.version}`;
  const ui = { zh: "界面", en: "UI", ja: "画面" }[language];
  const name = manifest.names[language];
  document.title = `${name} ${skinVersion} · ${brand} ${hostVersion}`;
  element("versions").textContent = `${brand} ${hostVersion} · ${ui} ${skinVersion}`;
  element("audio").textContent = [
    preview ? text[8] : "", audio?.running ? running : stopped,
    audio?.running && Number.isFinite(audio.sampleRate) ? `${audio.sampleRate} Hz / ${audio.bufferFrames} f` : "",
    Number.isFinite(audio?.latencyMs) ? `${audio.latencyMs.toFixed(1)} ms` : "",
    Number.isFinite(audio?.xruns) ? `XRUN ${audio.xruns}` : "",
  ].filter(Boolean).join("  ");
  const selected = command.current(), selectedEffect = command.effect();
  element("selection").textContent = `${channelLabel} ${selected ? "@" + selected.id : "—"}   ${effectLabel} ${selectedEffect ? "#" + selectedEffect.instance : "—"}`;
  for (const [index, id] of ["channel-col", "name-col", "gain-col", "state-col", "level-col", "hint"].entries()) {
    element(id).textContent = text[index];
  }
  status.textContent = busy ? text[6] : "";
  input.setAttribute("aria-label", text[7]);
  const channels = state.channels ?? [];
  const start = Math.max(0, channels.indexOf(selected) - 11);
  const visible = channels.slice(start, start + 12);
  const wanted = new Set(visible.map(channel => channel.id));
  for (const [id, row] of rows) if (!wanted.has(id)) { row.tr.remove(); rows.delete(id); }
  for (const [index, channel] of visible.entries()) {
    let row = rows.get(channel.id);
    if (!row) {
      const tr = document.createElement("tr");
      const cells = Array.from({ length: 5 }, () => document.createElement("td"));
      tr.append(...cells);
      row = { tr, cells };
      rows.set(channel.id, row);
    }
    if (body.children[index] !== row.tr) body.insertBefore(row.tr, body.children[index] ?? null);
    const [selector, name, gain, flags, meter] = row.cells;
    const active = selected === channel;
    selector.textContent = `${active ? ">" : " "} @${channel.id}`;
    if (active) selector.setAttribute("aria-current", "true");
    else selector.removeAttribute("aria-current");
    name.textContent = command.name(channel);
    name.title = name.textContent;
    gain.textContent = `${(channel.gainDb ?? 0).toFixed(1).padStart(5)} dB`;
    flags.textContent = `${channel.muted ? "M" : " "}${Math.abs(channel.phase ?? 0) > 90 ? language === "zh" ? "反" : "P" : " "}${channel.hidden ? "H" : " "}`;
    meter.textContent = peakText(peaks.get(channel.id));
  }
}

function clearOutput() {
  transcript.length = 0;
  output.textContent = "";
}

async function submit(line) {
  const trimmed = line.trim();
  if (!trimmed || busy) return;
  if (trimmed === "clear") { clearOutput(); return; }
  append(`> ${line}`);
  if (trimmed === "history") { append(history.slice(-50)); return; }
  busy = true;
  render();
  try {
    const result = await command.execute(line);
    if (typeof result === "string" || Array.isArray(result)) append(result);
  } catch (error) { report(error); }
  finally { busy = false; render(); }
}

element("prompt").addEventListener("submit", event => {
  event.preventDefault();
  if (composing) return;
  if (busy) { append(promptMessages[language][2]); return; }
  const line = input.value;
  if (line.trim() && history.at(-1) !== line) history.push(line);
  if (history.length > 100) history.shift();
  historyIndex = history.length;
  draft = "";
  input.value = "";
  void submit(line);
});
terminal.addEventListener("click", event => {
  if (event.target.closest?.("input, button, a, select, textarea, [contenteditable]") || transcriptSelected()) return;
  focusPrompt();
});
window.addEventListener("focus", focusPrompt);
window.addEventListener("pageshow", focusPrompt);
document.addEventListener("visibilitychange", focusPrompt);
input.addEventListener("compositionstart", () => {
  composing = true;
  input.setAttribute("data-composing", "");
});
function endComposition() {
  composing = false;
  input.removeAttribute("data-composing");
}
input.addEventListener("compositionend", endComposition);
input.addEventListener("blur", endComposition);
input.addEventListener("input", event => {
  if (event.inputType?.startsWith("insert")) historyIndex = history.length;
});
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.isComposing || composing || event.altKey || event.metaKey) return;
  const target = event.target;
  const fromPrompt = target === input;
  const onTerminal = terminal.contains(target) || target === document.body || target === document.documentElement;
  if (!fromPrompt && (!onTerminal || target.closest?.("input, textarea, select, [contenteditable]") ||
      document.querySelector('[aria-modal="true"]'))) return;
  const { key } = event;
  if (event.ctrlKey) {
    const lower = key.toLowerCase();
    const action = { l: "clear", y: "redo", z: "undo", c: "quit" }[lower];
    if (!action || (lower === "c" && (transcriptSelected() ||
        (fromPrompt && input.selectionStart !== input.selectionEnd)))) return;
    focusPrompt();
    event.preventDefault();
    if (event.repeat) return;
    if (action === "clear") clearOutput();
    else if (action === "quit") void command.execute("quit").catch(report);
    else void submit(action);
  } else if (!fromPrompt && [...key].length === 1) {
    focusPrompt();
    if (document.activeElement !== input) return;
    event.preventDefault();
    if (input.value.length - (input.selectionEnd - input.selectionStart) + key.length <= input.maxLength) {
      input.setRangeText(key, input.selectionStart, input.selectionEnd, "end");
      historyIndex = history.length;
    }
  } else if (key === "Escape") {
    event.preventDefault();
    focusPrompt();
    input.value = "";
  } else if (key === "Tab") {
    event.preventDefault();
    focusPrompt();
    if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) {
      append(promptMessages[language][0]);
      return;
    }
    const result = command.complete(input.value);
    if (!result.candidates.length) { append(promptMessages[language][1]); return; }
    input.value = result.line;
    input.setSelectionRange(input.value.length, input.value.length);
    if (result.candidates.length > 1) append(result.candidates.join("\n"));
  } else if (key === "ArrowUp" || key === "ArrowDown") {
    if (!history.length) return;
    focusPrompt();
    event.preventDefault();
    if (historyIndex === history.length) draft = input.value;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + (key === "ArrowUp" ? -1 : 1)));
    input.value = history[historyIndex] ?? draft;
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (key === "PageUp" || key === "PageDown") {
    event.preventDefault();
    focusPrompt();
    output.scrollTop += output.clientHeight * (key === "PageUp" ? -1 : 1);
  }
});
focusPrompt();

let rendered;
const stateReady = new Promise(resolve => { rendered = resolve; });
const startup = host.window.requiresStartup?.() ? new AbortController() : null;
if (startup) {
  const pageReady = document.readyState === "complete" ? Promise.resolve()
    : new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
  void revealNativeCover({ post: ({ phase }) => {
    if (phase === "show") host.window.showUnderCover();
    else if (phase === "complete") host.window.presentFrame();
    else host.window.startupFailed();
  }, stateReady, pageReady, fontsReady: document.fonts.ready, signal: startup.signal }).catch(report);
}
let dispose;
try {
  dispose = await mountSkin(host, next => {
    state = next;
    command.update(next);
    if (!next.audio?.running) peaks.clear();
    else {
      const ids = new Set((next.channels ?? []).map(channel => channel.id));
      for (const id of peaks.keys()) if (!ids.has(id)) peaks.delete(id);
    }
    language = Object.hasOwn(labels, next.i18n?.language) ? next.i18n.language : "zh";
    document.documentElement.lang = language;
    document.documentElement.setAttribute("data-theme", next.appearance?.theme ?? "dark");
    terminal.style.setProperty("--scale", String(next.appearance?.scale ?? 1));
    render();
    rendered();
  }, report, { borrowState: true });
} catch (error) {
  startup?.abort(error);
  throw error;
}
const disposeMeters = mountMeters(host, document, frame => {
  if (state.audio?.running === false) return;
  for (const meter of frame) {
    const peak = Math.max(meter.peak_l ?? meter.peak ?? 0, meter.peak_r ?? meter.peak ?? 0);
    peaks.set(meter.id, peak);
    const cell = rows.get(meter.id)?.cells[4];
    if (cell) cell.textContent = peakText(peak);
  }
}, report);
window.addEventListener("pagehide", event => {
  preview?.close();
  if (event.persisted) return;
  startup?.abort();
  disposeMeters();
  dispose();
  (local ?? preview?.host)?.close();
});
