import { sendLabel } from "./send-label.mjs";

const aliases = { h: "help", m: "mute", f: "fx", ch: "channel", g: "gain", u: "use", c: "config", p: "param" };
const help = [
  "use <@ID/UUID/name>  next  prev  channels",
  "gain [dB/+=dB/-=dB]  mute [on/off]  phase [on/off]  name <name>",
  "channel add/remove/hide on|off  record on|off",
  "fx list/use <index/#ID>/add/remove/move <index>/bypass [on/off]/open/menu",
  "send list  send <index> <dB>  send add <@ID>  send remove <index>",
  "effect list  undo  redo  history  open  save  settings  input",
  "play  pause  theme dark|light  lang zh|en|ja  clear  quit",
  "h=help m=mute f=fx ch=channel g=gain u=use",
];
const completions = [
  "help", "use ", "next", "prev", "channel", "channels", "gain ", "mute",
  "phase", "name ", "channel add", "channel remove", "channel hide ",
  "fx list", "fx use ", "fx add", "fx remove", "fx move ", "fx bypass", "fx open", "fx menu", "effect list",
  "send list", "send add ", "send remove ", "record ", "undo", "redo", "history",
  "open", "save", "settings", "input", "play", "pause", "theme dark", "theme light", "lang zh", "lang en",
  "lang ja", "clear", "quit",
];
const unsupported = new Set(["config", "param", "mode", "start", "stop"]);
const identity = channel => ({ chain_uuid: channel.chain_uuid ?? null, source_uuid: channel.source_uuid ?? null });
const channelKey = channel => JSON.stringify([channel.id, identity(channel)]);
const effectIdentity = (channel, effect) => ({
  channel: identity(channel), effect_uuid: effect.effect_uuid ?? null, path: effect.path ?? "",
  fuid: effect.fuid ?? null, cid: effect.cid ?? null,
});
const sendIdentity = (channel, send) => ({
  channel: identity(channel), id: send.id ?? null, dest: send.dest, output_channel: send.output_channel ?? null,
});
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function splitCommand(line) {
  const words = [];
  let word = "", quote = "", started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("unterminated quote");
  if (started) words.push(word);
  return words;
}

export function peakText(peak) {
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  const bars = Math.round(Math.max(0, Math.min(1, (db + 60) / 72)) * 12);
  return `${"=".repeat(bars)}${".".repeat(12 - bars)} ${db.toFixed(1).padStart(6)}`;
}

export function createTerminalCommands(host, anchor) {
  let state = {}, selection = null, effectInstance = null;
  const channels = () => state.channels ?? [];
  const rack = channel => (channel.rack ?? []).filter(effect => !/^@wdm-(?:play|rec)-\d+$/.test(effect.alias ?? ""));
  const current = () => channels().find(channel => channelKey(channel) === selection);
  const currentEffect = channel => rack(channel).find(effect => effect.instance === effectInstance);
  const select = channel => {
    selection = channel ? channelKey(channel) : null;
    effectInstance = channel ? rack(channel)[0]?.instance ?? null : null;
  };
  const update = next => {
    state = next;
    const channel = current();
    if (!channel) select(channels()[0]);
    else if (!currentEffect(channel)) effectInstance = rack(channel)[0]?.instance ?? null;
  };
  const name = channel => state.channelLabels?.[channel.id] ?? channel.name ?? `@${channel.id}`;
  const effectName = effect => state.effectLabels?.[effect.instance] ?? effect.alias ??
    state.effectInfo?.[effect.instance]?.name ?? effect.name ?? effect.path?.split(/[\\/]/).at(-1) ?? `#${effect.instance}`;
  const findChannel = query => {
    if (!query) return undefined;
    if (/^[@#]\d+$/.test(query)) return channels().find(channel => channel.id === Number(query.slice(1)));
    const matching = channels().filter(channel => channel.chain_uuid === query || channel.name === query);
    if (matching.length > 1) throw new Error("ambiguous channel; use @ID");
    return matching[0];
  };
  const needChannel = () => {
    const channel = current();
    if (!channel) throw new Error("select a channel with use");
    return channel;
  };
  const needEffect = channel => {
    const effect = currentEffect(channel);
    if (!effect) throw new Error("select an effect with fx use");
    return effect;
  };
  const gain = (value, previous, maximum) => {
    const relative = value.match(/^([+-])=(.+)$/);
    const raw = relative?.[2] ?? value;
    if (!number.test(raw)) throw new Error("invalid dB");
    const db = relative ? previous + (relative[1] === "+" ? 1 : -1) * Number(raw) : Number(raw);
    if (!Number.isFinite(db) || db < -60 || db > maximum) throw new Error(`dB: -60 .. ${maximum}`);
    return Math.round(db * 10) / 10;
  };
  const flag = (value, previous) => {
    if (value === undefined || value === "toggle") return !previous;
    if (value === "on" || value === "off") return value === "on";
    throw new Error("use on or off");
  };
  const byIndex = (items, query) => /^\d+$/.test(query) ? items[Number(query) - 1] : undefined;
  const invalid = () => { throw new Error("invalid command; help"); };

  async function effects(args) {
    const channel = needChannel();
    const [action = "list", value, ...rest] = args;
    if (rest.length) return invalid();
    const slots = rack(channel);
    if (action === "list" && value === undefined) {
      return slots.map((effect, index) => `${index + 1}  #${effect.instance}  ${effectName(effect)}`);
    }
    if (action === "add" && value === undefined) return host.effect.openBrowser(channel.id, identity(channel));
    if (action === "add" || action === "offline") throw new Error("use fx add or the effect menu");
    if (action === "use" && value) {
      const effect = value.startsWith("#") ? slots.find(slot => `#${slot.instance}` === value) : byIndex(slots, value);
      if (!effect) throw new Error("effect unavailable");
      effectInstance = effect.instance;
      return `#${effect.instance}  ${effectName(effect)}`;
    }
    const effect = needEffect(channel), expected = effectIdentity(channel, effect);
    if (action === "menu" && value === undefined) return host.menu.openEffect(channel.id, effect.instance, anchor(), expected);
    if (action === "open" && value === undefined) return host.effect.openEditor(channel.id, effect.instance, expected);
    if (action === "remove" && value === undefined) return host.effect.remove(channel.id, effect.instance, expected);
    if (action === "bypass") return host.effect.setBypass(channel.id, effect.instance, flag(value, effect.bypass), expected);
    if (action === "move" && value) {
      const target = byIndex(slots, value);
      if (!target) throw new Error("effect unavailable");
      return host.effect.move(channel.id, effect.instance, channel.rack.indexOf(target), expected,
        { instance: target.instance, ...effectIdentity(channel, target) });
    }
    return invalid();
  }

  async function sends(args) {
    const channel = needChannel();
    const [action = "list", value, ...rest] = args;
    if (rest.length) return invalid();
    const routes = channel.sends ?? [];
    if (action === "list" && value === undefined) return routes.map((send, index) =>
      `${index + 1}  ${sendLabel(send, state, host.i18n.t)}  ${(send.level_db ?? 0).toFixed(1)} dB`);
    if (action === "add" && value) {
      const target = findChannel(value);
      if (!target) throw new Error("channel unavailable");
      return host.channel.addSend(channel.id, `chain:${target.id}`, identity(channel));
    }
    const index = Number(action === "remove" ? value : action) - 1;
    const route = routes[index];
    if (!Number.isSafeInteger(index) || !route) return invalid();
    const expected = sendIdentity(channel, route);
    if (action === "remove") return host.channel.removeSend(channel.id, index, expected);
    if (value === undefined) return `${(route.level_db ?? 0).toFixed(1)} dB`;
    return host.channel.setSendLevel(channel.id, index,
      gain(value, route.level_db ?? 0, state.channelControls?.gainLimit ? 0 : 6), expected);
  }

  async function execute(line) {
    const [raw, ...args] = splitCommand(line);
    const cmd = Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
    const [arg, value] = args;
    if (unsupported.has(cmd)) throw new Error("command unavailable in this skin");
    if (cmd === "fx") return effects(args);
    if (cmd === "send") return sends(args);
    if (cmd !== "channel" && args.length > 1) return invalid();
    if (cmd === "help" && !args.length) return help;
    if ((cmd === "channels" || cmd === "channel") && !args.length) {
      return channels().map(channel => `@${channel.id}  ${name(channel)}  ${(channel.gainDb ?? 0).toFixed(1)} dB`);
    }
    if (cmd === "effect" && arg === "list") {
      return channels().flatMap(channel => rack(channel).map(effect => `@${channel.id}  #${effect.instance}  ${effectName(effect)}`));
    }
    if ((cmd === "use" && arg) || ((cmd === "next" || cmd === "prev") && !args.length)) {
      const rows = channels();
      const index = rows.indexOf(current());
      const target = cmd === "use" ? findChannel(arg) : rows[(index + rows.length + (cmd === "next" ? 1 : -1)) % rows.length];
      if (!target) throw new Error("channel unavailable");
      select(target);
      return `@${target.id}  ${name(target)}`;
    }
    if (cmd === "channel" && args.length <= 2) {
      if (arg === "add" && value === undefined) return host.channel.add(null);
      if (arg === "add") throw new Error("use channel add, then name");
      const channel = needChannel();
      if (arg === "remove" && value === undefined) return host.channel.remove(channel.id, identity(channel));
      if (arg === "hide") return host.channel.setHidden(channel.id, flag(value, channel.hidden), identity(channel));
    }
    if (cmd === "theme" && ["dark", "light"].includes(arg)) return host.appearance.setTheme(arg);
    if (cmd === "lang" && ["zh", "en", "ja"].includes(arg)) return host.i18n.setLanguage(arg);
    if (cmd === "open" || cmd === "save") {
      if (args.length) throw new Error("use open or save to choose a file");
      return host.document[cmd]();
    }
    if (args.length === 0) {
      if (cmd === "undo" || cmd === "redo") return host.history[cmd]();
      if (cmd === "quit") return host.window.close();
      if (cmd === "settings") return host.settings.open();
      if (cmd === "play" || cmd === "pause") return host.transport.setPlaying(cmd === "play");
      if (cmd === "input") {
        const channel = needChannel();
        return host.menu.openInput(channel.id, anchor(), identity(channel));
      }
    }
    if (!["gain", "mute", "phase", "record", "name"].includes(cmd)) return invalid();
    const channel = needChannel(), expected = identity(channel);
    if (cmd === "gain") {
      const previous = channel.gainDb ?? 0;
      if (arg === undefined) return `@${channel.id}  ${previous.toFixed(1)} dB`;
      await host.channel.setGain(channel.id, gain(arg, previous, state.channelControls?.gainLimit ? 0 : 12), expected);
      const updated = channels().find(item => channelKey(item) === channelKey(channel));
      return updated && updated.gainDb !== channel.gainDb ? `@${channel.id}  ${updated.gainDb.toFixed(1)} dB` : undefined;
    }
    if (cmd === "mute") return host.channel.setMute(channel.id, flag(arg, channel.muted), expected);
    if (cmd === "phase") return host.channel.setPhase(channel.id, flag(arg, Math.abs(channel.phase ?? 0) > 90) ? 180 : 0, expected);
    if (cmd === "record") return host.channel.setRecording(channel.id, flag(arg, channel.recording), expected);
    if (arg?.trim()) return host.channel.setName(channel.id, arg, expected);
    return invalid();
  }

  function complete(line) {
    const selectors = line.includes("#") ? ["@", "#"] : ["@"];
    const choices = [...completions,
      ...channels().flatMap(channel => selectors.flatMap(mark => [`use ${mark}${channel.id}`, `send add ${mark}${channel.id}`])),
      ...(current() ? rack(current()).map((_, index) => `fx use ${index + 1}`) : [])];
    for (const [alias, verb] of Object.entries(aliases)) {
      if (unsupported.has(verb)) continue;
      choices.push(alias, ...choices.filter(choice => choice.startsWith(verb + " "))
        .map(choice => alias + choice.slice(verb.length)));
    }
    let candidates = [...new Set(choices.filter(choice => choice.startsWith(line)))].sort();
    if (candidates.length > 1) candidates = candidates.filter(choice => choice !== line);
    if (!candidates.length) return { line, candidates };
    const shared = candidates.reduce((common, choice) => {
      while (!choice.startsWith(common)) common = common.slice(0, -1);
      return common;
    });
    return { line: shared, candidates };
  }

  return { update, execute, complete, current, name, effect: () => current() && currentEffect(current()) };
}
