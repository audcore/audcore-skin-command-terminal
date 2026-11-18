import test from "node:test";
import assert from "node:assert/strict";



import { createMockAudcore } from "../tests/support/mock-audcore.mjs";
import { createTerminalCommands, peakText, splitCommand } from "./terminal-commands.mjs";

function fixture() {
  const channels = [
    { id: 7, name: "人声", chain_uuid: "mic", gainDb: -3, rack: [{ instance: 11, name: "EQ" }], sends: [] },
    { id: 9, name: "Main", chain_uuid: "main", gainDb: 0, rack: [], sends: [] },
  ];
  return createMockAudcore({ channels, graph: { chains: channels }, appearance: { theme: "dark", scale: 1 } });
}

test("terminal accepts quoted names and dispatches typed operations against authoritative channel identities", async () => {
  assert.deepEqual(splitCommand('name "主唱 一"'), ["name", "主唱 一"]);
  assert.deepEqual(splitCommand('open "C:\\Audio Set\\Mic.audcore"'), ["open", "C:\\Audio Set\\Mic.audcore"]);
  assert.throws(() => splitCommand('name "broken'), /unterminated/);
  const host = fixture();
  const command = createTerminalCommands(host, () => ({ x: 0, y: 0 }));
  const update = () => command.update(host.fixture.snapshot().state);
  update();
  assert.equal(command.current().id, 7);
  assert.equal(command.complete("u @9").line, "u @9");
  assert.equal(command.complete("use #9").line, "use #9");
  assert.deepEqual(command.complete("use "), { line: "use @", candidates: ["use @7", "use @9"] });
  await command.execute("g +=1.5");
  update();
  assert.equal(await command.execute("gain"), "@7  -1.5 dB");
  await command.execute("m on");
  await command.execute('name "主唱 一"');
  await command.execute("fx bypass on");
  await command.execute("send add @9");
  update();
  assert.equal(command.current().name, "主唱 一");
  assert.equal(command.current().muted, true);
  assert.equal(command.effect().bypass, true);
  await command.execute("send 1 -6");
  update();
  assert.equal(command.current().sends[0].level_db, -6);
  await command.execute("use Main");
  assert.equal(command.current().id, 9);
  assert.equal(peakText(0), "............  -90.0");
  assert.equal(peakText(1), "==========..    0.0");
  await assert.rejects(command.execute("config set audio.buffer 128"), /unavailable/);
  await assert.rejects(command.execute("open arbitrary"), /choose a file/);
  await assert.rejects(command.execute("powershell -Command test"), /invalid command/);
  host.close();
});

test("terminal page renders host state and retains the prompt, history, and character meter", async () => {
  class Node {
    children = [];
    events = new Map();
    attributes = {};
    style = { setProperty() {} };
    value = "";
    scrollHeight = 100;
    clientHeight = 25;
    addEventListener(name, callback) { this.events.set(name, callback); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { children.forEach(child => this.insertBefore(child, null)); }
    insertBefore(child, next) {
      child.remove();
      child.parent = this;
      const at = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(at, 0, child);
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    setRangeText(text, start, end, mode) {
      assert.equal(mode, "end");
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.setSelectionRange(start + text.length, start + text.length);
    }
    focus() { document.activeElement = this; }
  }
  const host = fixture();
  const html = new Node();
  const nodes = new Map();
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  };
  const previous = { document: globalThis.document, window: globalThis.window };
  const windows = new Map();
  const event = { preventDefault() {} };
  try {
    const selection = { isCollapsed: true };
    globalThis.window = {
      location: { search: "?hostVersion=v0.0.3200" },
      audcore: host, getSelection: () => selection, addEventListener(name, callback) { windows.set(name, callback); }
    };
    globalThis.document = Object.assign(new Node(), {
      body: new Node(), documentElement: html, getElementById, createElement: () => new Node(), querySelector: () => null,
    });
    await import("./terminal-page.mjs?mock");
    assert.equal(document.title, "命令终端 v0.1.5 · 声核 v0.0.3200");
    assert.equal(nodes.get("versions").textContent, "声核 v0.0.3200 · 界面 v0.1.5");
    assert.match(nodes.get("audio").textContent, /48000 Hz/);
    assert.equal(nodes.get("channels").children.length, 2);
    const input = nodes.get("command"), terminal = nodes.get("terminal");
    const keydown = document.events.get("keydown");
    input.maxLength = 4096;
    assert.equal(document.activeElement, input);
    document.activeElement = document.body;
    terminal.events.get("click")({ target: terminal });
    assert.equal(document.activeElement, input);
    document.activeElement = document.body;
    selection.isCollapsed = false;
    terminal.events.get("click")({ target: terminal });
    assert.equal(document.activeElement, document.body);
    selection.isCollapsed = true;
    windows.get("focus")();
    assert.equal(document.activeElement, input);

    input.value = "gin";
    input.setSelectionRange(1, 1);
    document.activeElement = document.body;
    keydown({ ...event, key: "a", target: document.body });
    assert.equal(input.value, "gain");
    assert.equal(input.selectionStart, 2);
    assert.equal(document.activeElement, input);
    input.events.get("compositionstart")();
    assert.equal(input.attributes["data-composing"], "");
    nodes.get("prompt").events.get("submit")(event);
    assert.equal(input.value, "gain");
    input.events.get("compositionend")();
    assert.equal(input.attributes["data-composing"], undefined);

    input.value = "mute on";
    nodes.get("prompt").events.get("submit")(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(nodes.get("output").textContent, /^> mute on$/);
    const output = nodes.get("output");
    const scroll = output.scrollTop;
    keydown({ ...event, key: "PageUp", target: input });
    assert.equal(output.scrollTop, scroll - output.clientHeight);
    keydown({ ...event, key: "PageDown", target: input });
    assert.equal(output.scrollTop, scroll);
    assert.equal(host.fixture.snapshot().state.channels[0].muted, true);
    input.value = "draft";
    keydown({ ...event, key: "ArrowUp", target: input });
    assert.equal(input.value, "mute on");
    keydown({ ...event, key: "ArrowDown", target: input });
    assert.equal(input.value, "draft");
    keydown({ ...event, key: "Escape", target: input });
    assert.equal(input.value, "");
    input.value = "use @";
    input.setSelectionRange(3, 3);
    keydown({ ...event, key: "Tab", target: input });
    assert.equal(input.value, "use @");
    assert.equal(input.selectionStart, 3);
    assert.match(output.textContent, /请将光标移到行尾再补全/);
    input.value = "missing";
    input.setSelectionRange(7, 7);
    keydown({ ...event, key: "Tab", target: input });
    assert.match(output.textContent, /无匹配候选/);
    input.value = "u @9";
    input.setSelectionRange(4, 4);
    keydown({ ...event, key: "Tab", target: input });
    assert.equal(input.value, "u @9");
    assert.equal(input.selectionStart, input.value.length);
    keydown({ ...event, key: "l", ctrlKey: true, target: input });
    assert.equal(output.textContent, "");
    assert.equal(input.value, "u @9");
    assert.equal(nodes.get("channels").children[0].children[0].textContent, "> @7");
    nodes.get("prompt").events.get("submit")(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get("channels").children[1].children[0].textContent, "> @9");
    host.fixture.publishMeters([{ id: 7, peak: 1 }]);
    assert.equal(nodes.get("channels").children[0].children[4].textContent, peakText(1));
    host.fixture.update("i18n", { language: "ja", messages: {} });
    assert.equal(nodes.get("channel-col").textContent, "通路");
    assert.equal(document.title, "端末 v0.1.5 · 声核 v0.0.3200");
    assert.equal(nodes.get("versions").textContent, "声核 v0.0.3200 · 画面 v0.1.5");
    host.fixture.update("appearance", { theme: "light", scale: 1.25 });
    assert.equal(html.attributes["data-theme"], "light");
    windows.get("pagehide")({ persisted: false });
  } finally {
    host.close();
    Object.assign(globalThis, previous);
  }
});
