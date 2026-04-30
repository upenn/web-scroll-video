#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import net from "node:net";

const DEFAULT_URL = "https://www.wharton.upenn.edu/";

function printUsage() {
  console.log(`Usage:
  scroll-video [url] [options]
  scroll-video --script <path> [options]

Options:
  --script <path>        Run a sequence-style cue sheet (.cue, .txt, or .json).
  --out <path>           Output MP4 path. Default: scroll-video.mp4, or <script>.mp4 in script mode.
  --width <px>           Viewport width. Default: 1920
  --height <px>          Viewport height. Default: 1080
  --fps <number>         Video frames per second. Default: 30
  --speed <px/sec>       Scroll speed in CSS pixels per second. Default: 480
  --duration <seconds>   Override speed and fit full scroll into this duration.
  --delay <ms>           Extra wait after page load. Default: 1500
  --warmup-step <px>     Lazy-load warmup scroll step. Default: viewport height
  --chrome-path <path>   Chrome/Chromium/Edge executable path.
  --ffmpeg-path <path>   ffmpeg executable path. Default: ffmpeg
  --crf <number>         H.264 quality, lower is better. Default: 18
  --cursor               Show a rendered cursor overlay in script mode.
  --storyboard <dir>     Save one PNG screenshot after each script step.
  --keep-browser         Leave the temporary Chrome profile directory in place.
  --help                 Show this help.

Examples:
  scroll-video https://www.wharton.upenn.edu/ --out wharton-scroll.mp4
  npm run capture -- https://example.com --duration 12 --fps 60
  scroll-video --script wharton-demo.cue
`);
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    out: "scroll-video.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    speed: 480,
    duration: null,
    delayMs: 1500,
    warmupStep: null,
    chromePath: process.env.CHROME_PATH || null,
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    crf: 18,
    scriptPath: null,
    cursor: false,
    storyboardDir: null,
    keepBrowser: false,
    explicit: new Set(),
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (!arg.startsWith("-")) {
      options.url = arg;
      options.explicit.add("url");
      continue;
    }

    const readValue = () => {
      const value = args.shift();
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };

    switch (arg) {
      case "--script":
        options.scriptPath = readValue();
        options.explicit.add("scriptPath");
        break;
      case "--out":
      case "-o":
        options.out = readValue();
        options.explicit.add("out");
        break;
      case "--width":
        options.width = parsePositiveInteger(readValue(), arg);
        options.explicit.add("width");
        break;
      case "--height":
        options.height = parsePositiveInteger(readValue(), arg);
        options.explicit.add("height");
        break;
      case "--fps":
        options.fps = parsePositiveNumber(readValue(), arg);
        options.explicit.add("fps");
        break;
      case "--speed":
        options.speed = parsePositiveNumber(readValue(), arg);
        options.explicit.add("speed");
        break;
      case "--duration":
        options.duration = parsePositiveNumber(readValue(), arg);
        options.explicit.add("duration");
        break;
      case "--delay":
        options.delayMs = parseNonNegativeInteger(readValue(), arg);
        options.explicit.add("delayMs");
        break;
      case "--warmup-step":
        options.warmupStep = parsePositiveInteger(readValue(), arg);
        options.explicit.add("warmupStep");
        break;
      case "--chrome-path":
        options.chromePath = readValue();
        options.explicit.add("chromePath");
        break;
      case "--ffmpeg-path":
        options.ffmpegPath = readValue();
        options.explicit.add("ffmpegPath");
        break;
      case "--crf":
        options.crf = parsePositiveInteger(readValue(), arg);
        options.explicit.add("crf");
        break;
      case "--cursor":
        options.cursor = true;
        options.explicit.add("cursor");
        break;
      case "--no-cursor":
        options.cursor = false;
        options.explicit.add("cursor");
        break;
      case "--storyboard":
        options.storyboardDir = readValue();
        options.explicit.add("storyboardDir");
        break;
      case "--keep-browser":
        options.keepBrowser = true;
        options.explicit.add("keepBrowser");
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.scriptPath) {
    options.scriptPath = resolve(options.scriptPath);
  } else {
    options.out = resolve(options.out);
  }
  if (options.storyboardDir && !options.scriptPath) {
    options.storyboardDir = resolve(options.storyboardDir);
  }
  options.warmupStep ??= options.height;
  return options;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseBoolean(value, name) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be on/off, true/false, or yes/no`);
}

function parseSeconds(value, name) {
  const text = String(value).trim().toLowerCase().replace(/s$/, "");
  return parsePositiveNumber(text, name);
}

function parseJsonValue(value) {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return /^true$/i.test(trimmed);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function tokenizeCueLine(line) {
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    tokens.push(value.replace(/\\(["'\\])/g, "$1"));
  }

  return tokens;
}

function normalizeOptionKey(key) {
  const normalized = key.trim().replace(/-/g, "_").toLowerCase();
  const map = {
    output: "out",
    out: "out",
    width: "width",
    height: "height",
    fps: "fps",
    speed: "speed",
    duration: "duration",
    delay: "delayMs",
    warmup_step: "warmupStep",
    chrome_path: "chromePath",
    ffmpeg_path: "ffmpegPath",
    crf: "crf",
    cursor: "cursor",
    storyboard: "storyboardDir",
  };
  return map[normalized] || null;
}

function normalizeScriptOption(key, value) {
  switch (key) {
    case "width":
    case "height":
    case "warmupStep":
    case "crf":
      return parsePositiveInteger(String(value), key);
    case "fps":
    case "speed":
    case "duration":
      return parsePositiveNumber(String(value), key);
    case "delayMs":
      return parseNonNegativeInteger(String(value), "delay");
    case "cursor":
      return parseBoolean(value, "cursor");
    case "out":
    case "chromePath":
    case "ffmpegPath":
    case "storyboardDir":
      return String(value);
    default:
      return value;
  }
}

function loadCueScript(scriptPath) {
  const source = readFileSync(scriptPath, "utf8");
  const extension = extname(scriptPath).toLowerCase();
  if (extension === ".json") {
    return normalizeJsonCueScript(JSON.parse(source));
  }
  return parseTextCueScript(source);
}

function normalizeJsonCueScript(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("JSON cue script must be an object with a steps array");
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error("JSON cue script must include a steps array");
  }

  const scriptOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "steps") {
      continue;
    }
    const optionKey = normalizeOptionKey(key);
    if (optionKey) {
      scriptOptions[optionKey] = normalizeScriptOption(optionKey, value);
    }
  }

  return {
    options: scriptOptions,
    steps: raw.steps.map((step, index) => normalizeCueStep(step, index + 1)),
  };
}

function parseTextCueScript(source) {
  const scriptOptions = {};
  const steps = [];

  for (const [lineIndex, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const optionMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (optionMatch) {
      const optionKey = normalizeOptionKey(optionMatch[1]);
      if (!optionKey) {
        throw new Error(`Unknown cue option on line ${lineIndex + 1}: ${optionMatch[1]}`);
      }
      scriptOptions[optionKey] = normalizeScriptOption(
        optionKey,
        parseJsonValue(optionMatch[2]),
      );
      continue;
    }

    const tokens = tokenizeCueLine(line);
    if (tokens.length === 0) {
      continue;
    }

    if (tokens[0].toLowerCase() === "cursor") {
      if (tokens.length !== 2) {
        throw new Error(`Use "cursor: on" or "cursor on" on line ${lineIndex + 1}`);
      }
      scriptOptions.cursor = parseBoolean(tokens[1], "cursor");
      continue;
    }

    steps.push(parseTextCueStep(tokens, lineIndex + 1));
  }

  if (steps.length === 0) {
    throw new Error("Cue script does not contain any steps");
  }

  return { options: scriptOptions, steps };
}

function parseTextCueStep(tokens, lineNumber) {
  const action = tokens[0].toLowerCase();
  const at = (word) => tokens.findIndex((token) => token.toLowerCase() === word);

  switch (action) {
    case "go":
    case "open":
      if (tokens.length < 2) {
        throw new Error(`go requires a URL on line ${lineNumber}`);
      }
      return { action: "go", url: tokens.slice(1).join(" ") };
    case "pause":
    case "hold":
      if (tokens.length !== 2) {
        throw new Error(`pause requires seconds on line ${lineNumber}`);
      }
      return { action: "pause", seconds: parseSeconds(tokens[1], "pause") };
    case "scroll": {
      const mode = tokens[1]?.toLowerCase();
      const durationIndex = at("over");
      if (!["to", "by"].includes(mode) || durationIndex === -1 || durationIndex <= 2) {
        throw new Error(`Use "scroll to bottom over 5", "scroll to Visible Text over 5", or "scroll by 800 over 2" on line ${lineNumber}`);
      }
      const rawValue = tokens.slice(2, durationIndex).join(" ");
      return {
        action: "scroll",
        mode,
        value: mode === "by"
          ? normalizeScrollValue(tokens[2], lineNumber)
          : normalizeScrollValue(rawValue, lineNumber),
        duration: parseSeconds(tokens[durationIndex + 1], "scroll duration"),
      };
    }
    case "click":
      return {
        action: "click",
        target: parseTargetTokens(tokens.slice(1), lineNumber, "click"),
      };
    case "type": {
      if (!tokens[1]) {
        throw new Error(`type requires text on line ${lineNumber}`);
      }
      const intoIndex = at("into");
      const durationIndex = at("over");
      const untilIndex = [intoIndex, durationIndex].filter((index) => index !== -1).sort((a, b) => a - b)[0] ?? tokens.length;
      const step = {
        action: "type",
        text: tokens.slice(1, untilIndex).join(" "),
      };
      if (intoIndex !== -1) {
        const targetEnd = durationIndex !== -1 && durationIndex > intoIndex
          ? durationIndex
          : tokens.length;
        step.target = parseTargetTokens(tokens.slice(intoIndex + 1, targetEnd), lineNumber, "type target");
      }
      if (durationIndex !== -1) {
        step.duration = parseSeconds(tokens[durationIndex + 1], "type duration");
      }
      return step;
    }
    case "press":
      if (!tokens[1]) {
        throw new Error(`press requires a key on line ${lineNumber}`);
      }
      return { action: "press", key: tokens.slice(1).join(" ") };
    case "wait": {
      const timeoutIndex = at("timeout");
      const targetTokens = timeoutIndex === -1 ? tokens.slice(1) : tokens.slice(1, timeoutIndex);
      const step = {
        action: "wait",
        target: parseTargetTokens(targetTokens, lineNumber, "wait"),
        timeout: 10,
      };
      if (timeoutIndex !== -1) {
        step.timeout = parseSeconds(tokens[timeoutIndex + 1], "wait timeout");
      }
      return step;
    }
    case "zoom": {
      const durationIndex = at("over");
      const valueIndex = tokens[1]?.toLowerCase() === "to" ? 2 : 1;
      if (!tokens[valueIndex]) {
        throw new Error(`zoom requires a scale on line ${lineNumber}`);
      }
      return {
        action: "zoom",
        to: parsePositiveNumber(tokens[valueIndex], "zoom"),
        duration: durationIndex === -1
          ? 0
          : parseSeconds(tokens[durationIndex + 1], "zoom duration"),
      };
    }
    case "highlight": {
      const durationIndex = at("for");
      const targetTokens = durationIndex === -1 ? tokens.slice(1) : tokens.slice(1, durationIndex);
      return {
        action: "highlight",
        target: parseTargetTokens(targetTokens, lineNumber, "highlight"),
        duration: durationIndex === -1
          ? 1
          : parseSeconds(tokens[durationIndex + 1], "highlight duration"),
      };
    }
    default:
      throw new Error(`Unknown cue action on line ${lineNumber}: ${tokens[0]}`);
  }
}

function parseTargetTokens(tokens, lineNumber, actionName) {
  if (tokens.length === 0) {
    throw new Error(`${actionName} requires a target on line ${lineNumber}`);
  }
  const kind = tokens[0].toLowerCase();
  if (["text", "selector", "label"].includes(kind)) {
    if (!tokens[1]) {
      throw new Error(`${actionName} ${kind} requires a value on line ${lineNumber}`);
    }
    return { [kind]: tokens.slice(1).join(" ") };
  }
  return { text: tokens.join(" ") };
}

function normalizeScrollValue(value, lineNumber) {
  if (value && typeof value === "object") {
    if (value.text !== undefined || value.selector !== undefined || value.label !== undefined) {
      return normalizeTarget(value);
    }
    throw new Error(`Invalid scroll target on line ${lineNumber}`);
  }

  const normalized = String(value).toLowerCase();
  if (["top", "bottom"].includes(normalized)) {
    return normalized;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return { text: String(value) };
}

function normalizeCueStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`Step ${index} must be an object`);
  }

  if (step.go !== undefined) {
    return { action: "go", url: String(step.go) };
  }
  if (step.pause !== undefined || step.hold !== undefined) {
    return { action: "pause", seconds: parseSeconds(step.pause ?? step.hold, `step ${index} pause`) };
  }
  if (step.scroll !== undefined) {
    const scroll = typeof step.scroll === "object" ? step.scroll : { to: step.scroll };
    const mode = scroll.by !== undefined ? "by" : "to";
    const value = scroll.by ?? scroll.to ?? "bottom";
    return {
      action: "scroll",
      mode,
      value: normalizeScrollValue(value, index),
      duration: parseSeconds(scroll.duration ?? scroll.over ?? 1, `step ${index} scroll duration`),
    };
  }
  if (step.click !== undefined) {
    return { action: "click", target: normalizeTarget(step.click) };
  }
  if (step.type !== undefined) {
    const type = typeof step.type === "object" ? step.type : { text: step.type };
    const normalized = {
      action: "type",
      text: String(type.text ?? ""),
    };
    if (type.into !== undefined) {
      normalized.target = normalizeTarget(type.into);
    }
    if (type.duration !== undefined || type.over !== undefined) {
      normalized.duration = parseSeconds(type.duration ?? type.over, `step ${index} type duration`);
    }
    return normalized;
  }
  if (step.press !== undefined) {
    return { action: "press", key: String(step.press) };
  }
  if (step.wait !== undefined) {
    const wait = typeof step.wait === "object" ? step.wait : { text: step.wait };
    return {
      action: "wait",
      target: normalizeTarget(wait),
      timeout: parseSeconds(wait.timeout ?? 10, `step ${index} wait timeout`),
    };
  }
  if (step.zoom !== undefined) {
    const zoom = typeof step.zoom === "object" ? step.zoom : { to: step.zoom };
    return {
      action: "zoom",
      to: parsePositiveNumber(String(zoom.to ?? zoom.scale), `step ${index} zoom`),
      duration: zoom.duration === undefined && zoom.over === undefined
        ? 0
        : parseSeconds(zoom.duration ?? zoom.over, `step ${index} zoom duration`),
    };
  }
  if (step.highlight !== undefined) {
    const highlight = typeof step.highlight === "object"
      ? step.highlight
      : { text: step.highlight };
    return {
      action: "highlight",
      target: normalizeTarget(highlight),
      duration: parseSeconds(highlight.duration ?? highlight.for ?? 1, `step ${index} highlight duration`),
    };
  }

  throw new Error(`Step ${index} has no supported action`);
}

function normalizeTarget(target) {
  if (typeof target === "string" || typeof target === "number") {
    return { text: String(target) };
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("Target must be text, selector, label, or an object");
  }
  if (target.selector !== undefined) {
    return { selector: String(target.selector) };
  }
  if (target.label !== undefined) {
    return { label: String(target.label) };
  }
  if (target.text !== undefined) {
    return { text: String(target.text) };
  }
  if (target.into !== undefined) {
    return normalizeTarget(target.into);
  }
  throw new Error("Target must include text, selector, or label");
}

function resolveFromScriptDir(scriptPath, filePath) {
  return isAbsolute(filePath)
    ? filePath
    : resolve(dirname(scriptPath), filePath);
}

function mergeScriptOptions(options, scriptOptions) {
  const scriptHasOut = Object.prototype.hasOwnProperty.call(scriptOptions, "out");
  const scriptHasStoryboard = Object.prototype.hasOwnProperty.call(scriptOptions, "storyboardDir");
  const cliHasOut = options.explicit.has("out");
  const cliHasStoryboard = options.explicit.has("storyboardDir");

  for (const [key, value] of Object.entries(scriptOptions)) {
    if (!options.explicit.has(key)) {
      options[key] = value;
    }
  }

  if (cliHasOut) {
    options.out = resolve(options.out);
  } else if (scriptHasOut) {
    options.out = resolveFromScriptDir(options.scriptPath, options.out);
  } else {
    options.out = resolve(
      dirname(options.scriptPath),
      `${basename(options.scriptPath, extname(options.scriptPath))}.mp4`,
    );
  }

  if (options.storyboardDir) {
    options.storyboardDir = cliHasStoryboard || !scriptHasStoryboard
      ? resolve(options.storyboardDir)
      : resolveFromScriptDir(options.scriptPath, options.storyboardDir);
  }
  return options;
}

function findChromePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "Could not find Chrome or Chromium. Set CHROME_PATH or pass --chrome-path.",
    );
  }
  return found;
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}`);
}

class CdpConnection {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  async ready() {
    await this.openPromise;
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    for (const waiter of [...this.eventWaiters]) {
      if (
        waiter.method === message.method &&
        (!waiter.sessionId || waiter.sessionId === message.sessionId)
      ) {
        this.eventWaiters = this.eventWaiters.filter((item) => item !== waiter);
        waiter.resolve(message.params || {});
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  waitForEvent(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject };
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      waiter.resolve = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.eventWaiters.push(waiter);
    });
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome(options) {
  const chromePath = findChromePath(options.chromePath);
  const userDataDir = mkdtempSync(join(tmpdir(), "scroll-video-chrome-"));
  const port = await getFreePort();

  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-dev-shm-usage",
    "--disable-renderer-backgrounding",
    "--disable-smooth-scrolling",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let chromeStderr = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += chunk;
  });

  chrome.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`Chrome exited early (${signal || code}).`);
      if (chromeStderr.trim()) {
        console.error(chromeStderr.trim());
      }
    }
  });

  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
  const cdp = new CdpConnection(version.webSocketDebuggerUrl);
  await cdp.ready();

  return { chrome, cdp, userDataDir };
}

async function waitForPageComplete(cdp, sessionId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const readyState = await evaluate(cdp, sessionId, "document.readyState");
    if (readyState === "complete") {
      return;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for document.readyState === 'complete'");
}

async function evaluate(cdp, sessionId, expression, options = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: Boolean(options.awaitPromise),
    returnByValue: true,
  }, sessionId);

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "Runtime.evaluate failed";
    throw new Error(text);
  }

  return result.result.value;
}

async function createPage(cdp, options) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: options.width,
    height: options.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: options.width,
    screenHeight: options.height,
  }, sessionId);

  return sessionId;
}

async function openUrl(cdp, sessionId, url, delayMs) {
  console.log(`Opening ${url}`);
  const loadEvent = cdp.waitForEvent("Page.loadEventFired", sessionId, 60000).catch(() => null);
  await cdp.send("Page.navigate", { url }, sessionId);
  await Promise.race([
    loadEvent,
    waitForPageComplete(cdp, sessionId, 60000),
  ]);
  await waitForPageComplete(cdp, sessionId, 60000).catch(() => null);
  await delay(delayMs);

  await evaluate(cdp, sessionId, `
    (() => {
      const style = document.createElement("style");
      style.textContent = "html, body, * { scroll-behavior: auto !important; }";
      document.documentElement.appendChild(style);
      window.scrollTo(0, 0);
      return true;
    })()
  `);
}

async function preparePage(cdp, sessionId, options) {
  await openUrl(cdp, sessionId, options.url, options.delayMs);

  let pageHeight = await getPageHeight(cdp, sessionId);
  const firstMaxScroll = Math.max(0, pageHeight - options.height);

  if (firstMaxScroll > 0) {
    console.log("Warming page to trigger lazy-loaded content");
    for (let y = 0; y <= firstMaxScroll; y += options.warmupStep) {
      await scrollTo(cdp, sessionId, y);
      await delay(120);
    }
    await scrollTo(cdp, sessionId, firstMaxScroll);
    await delay(350);
    pageHeight = await getPageHeight(cdp, sessionId);
    await scrollTo(cdp, sessionId, 0);
    await delay(350);
  }

  return {
    pageHeight,
    maxScroll: Math.max(0, pageHeight - options.height),
  };
}

async function getPageHeight(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.offsetHeight,
      document.body ? document.body.offsetHeight : 0,
      document.documentElement.clientHeight
    ))
  `);
}

async function scrollTo(cdp, sessionId, y) {
  await evaluate(cdp, sessionId, `
    new Promise((resolve) => {
      window.scrollTo(0, ${JSON.stringify(Math.max(0, y))});
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `, { awaitPromise: true });
}

async function getCurrentScrollY(cdp, sessionId) {
  return evaluate(cdp, sessionId, "window.scrollY || document.documentElement.scrollTop || 0");
}

async function setupScriptRuntime(cdp, sessionId, options) {
  await evaluate(cdp, sessionId, `
    (() => {
      if (!document.getElementById("__scroll_video_runtime_style")) {
        const style = document.createElement("style");
        style.id = "__scroll_video_runtime_style";
        style.textContent = [
          "#__scroll_video_cursor { position: fixed; width: 0; height: 0; border-top: 0 solid transparent; border-bottom: 22px solid transparent; border-left: 32px solid #111; filter: drop-shadow(0 2px 3px rgba(255,255,255,.8)); pointer-events: none; z-index: 2147483647; display: none; }",
          "#__scroll_video_highlight { position: fixed; pointer-events: none; border: 6px solid #ffd400; box-shadow: 0 0 0 4px rgba(0,0,0,.65), 0 0 22px rgba(255,212,0,.85); border-radius: 6px; z-index: 2147483646; display: none; box-sizing: border-box; }"
        ].join("\\n");
        document.documentElement.appendChild(style);
      }
      if (!document.getElementById("__scroll_video_cursor")) {
        const cursor = document.createElement("div");
        cursor.id = "__scroll_video_cursor";
        document.documentElement.appendChild(cursor);
      }
      if (!document.getElementById("__scroll_video_highlight")) {
        const highlight = document.createElement("div");
        highlight.id = "__scroll_video_highlight";
        document.documentElement.appendChild(highlight);
      }
      window.__scrollVideoZoom = window.__scrollVideoZoom || 1;
      return true;
    })()
  `);
  await setCursorVisible(cdp, sessionId, options.cursor);
}

async function setCursorVisible(cdp, sessionId, visible) {
  await evaluate(cdp, sessionId, `
    (() => {
      const cursor = document.getElementById("__scroll_video_cursor");
      if (cursor) cursor.style.display = ${visible ? JSON.stringify("block") : JSON.stringify("none")};
      return true;
    })()
  `);
}

async function setCursorPosition(cdp, sessionId, x, y) {
  await evaluate(cdp, sessionId, `
    (() => {
      const cursor = document.getElementById("__scroll_video_cursor");
      if (!cursor) return false;
      cursor.style.left = ${JSON.stringify(x)} + "px";
      cursor.style.top = ${JSON.stringify(y)} + "px";
      return true;
    })()
  `);
}

async function getZoom(cdp, sessionId) {
  return evaluate(cdp, sessionId, "window.__scrollVideoZoom || 1");
}

async function setZoom(cdp, sessionId, zoom) {
  await evaluate(cdp, sessionId, `
    (() => {
      window.__scrollVideoZoom = ${JSON.stringify(zoom)};
      document.documentElement.style.zoom = String(${JSON.stringify(zoom)});
      return true;
    })()
  `);
}

function targetDescription(target) {
  if (target.selector) {
    return `selector "${target.selector}"`;
  }
  if (target.label) {
    return `label "${target.label}"`;
  }
  return `text "${target.text}"`;
}

async function resolveElementBox(cdp, sessionId, target, options = {}) {
  const shouldScrollIntoView = options.scrollIntoView !== false;
  const targetJson = JSON.stringify(target);
  const shouldScrollJson = JSON.stringify(shouldScrollIntoView);
  const box = await evaluate(cdp, sessionId, `
    (async () => {
      const target = ${targetJson};
      const shouldScrollIntoView = ${shouldScrollJson};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const wanted = normalize(target.text || target.label || "");
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const boxFor = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          tag: element.tagName.toLowerCase(),
          text: normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").slice(0, 160)
        };
      };
      const finish = async (element) => {
        if (!element || !isVisible(element)) return null;
        if (shouldScrollIntoView) {
          element.scrollIntoView({ block: "center", inline: "center" });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        return boxFor(element);
      };

      let element = null;
      if (target.selector) {
        element = document.querySelector(target.selector);
        return finish(element);
      }

      if (target.label) {
        for (const candidate of document.querySelectorAll("input, textarea, select, button, a, [role='button'], [aria-label], [placeholder]")) {
          const labelText = normalize([
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("placeholder"),
            candidate.getAttribute("name"),
            candidate.id
          ].filter(Boolean).join(" "));
          if (labelText.includes(wanted) && isVisible(candidate)) {
            return finish(candidate);
          }
        }
        for (const label of document.querySelectorAll("label")) {
          if (!normalize(label.innerText || label.textContent).includes(wanted) || !isVisible(label)) continue;
          const control = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null) || label.querySelector("input, textarea, select, button");
          return finish(control || label);
        }
      }

      const candidates = [];
      const selector = "a, button, input, textarea, select, [role='button'], [aria-label], [placeholder], label, h1, h2, h3, h4, h5, h6, p, span, li, div";
      for (const candidate of document.querySelectorAll(selector)) {
        if (!isVisible(candidate)) continue;
        const text = normalize([
          candidate.innerText,
          candidate.textContent,
          candidate.value,
          candidate.getAttribute("aria-label"),
          candidate.getAttribute("placeholder")
        ].filter(Boolean).join(" "));
        if (!text.includes(wanted)) continue;
        const rect = candidate.getBoundingClientRect();
        candidates.push({ element: candidate, area: rect.width * rect.height });
      }
      candidates.sort((a, b) => a.area - b.area);
      element = candidates[0]?.element || null;
      return finish(element);
    })()
  `, { awaitPromise: true });

  if (!box) {
    throw new Error(`Could not find ${targetDescription(target)}`);
  }
  return box;
}

class VideoWriter {
  constructor(options) {
    const { ffmpeg, getStderr } = startFfmpeg(options);
    this.ffmpeg = ffmpeg;
    this.getStderr = getStderr;
    this.frames = 0;
    this.finished = false;
  }

  async writeCurrentFrame(cdp, sessionId) {
    const frame = await captureFrame(cdp, sessionId);
    await writeFrame(this.ffmpeg, frame);
    this.frames += 1;
  }

  async finish() {
    if (this.finished) {
      return;
    }
    if (this.frames === 0) {
      this.abort();
      throw new Error("Script did not render any timed frames. Add a pause, scroll, zoom duration, type duration, or highlight duration.");
    }
    this.finished = true;
    this.ffmpeg.stdin.end();
    const [code] = await once(this.ffmpeg, "close");
    if (code !== 0) {
      throw new Error(`ffmpeg failed with exit code ${code}:\n${this.getStderr()}`);
    }
  }

  abort() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.ffmpeg.stdin.destroy();
    this.ffmpeg.kill("SIGTERM");
  }
}

async function captureDurationFrames(cdp, sessionId, writer, options, seconds, beforeFrame) {
  const frameCount = Math.max(1, Math.round(seconds * options.fps));
  const frameMs = 1000 / options.fps;
  const startedAt = Date.now();

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const progress = frameCount === 1 ? 1 : frameIndex / (frameCount - 1);
    if (beforeFrame) {
      await beforeFrame(progress, frameIndex, frameCount);
    }
    await writer.writeCurrentFrame(cdp, sessionId);

    const nextFrameAt = startedAt + ((frameIndex + 1) * frameMs);
    const waitMs = nextFrameAt - Date.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
  }
}

async function clickTarget(cdp, sessionId, target, options) {
  const box = await resolveElementBox(cdp, sessionId, target);
  if (options.cursor) {
    await setCursorVisible(cdp, sessionId, true);
    await setCursorPosition(cdp, sessionId, box.x, box.y);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y,
  }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  }, sessionId);
  await delay(250);
}

async function typeText(cdp, sessionId, step, writer, options) {
  if (step.target) {
    await clickTarget(cdp, sessionId, step.target, options);
  }

  const chars = [...step.text];
  if (chars.length === 0) {
    throw new Error("type step requires non-empty text");
  }
  const duration = step.duration ?? Math.max(0.3, chars.length * 0.06);
  let inserted = 0;

  await captureDurationFrames(cdp, sessionId, writer, options, duration, async (progress) => {
    const targetCount = Math.min(chars.length, Math.floor((progress * chars.length) + 1));
    while (inserted < targetCount) {
      await cdp.send("Input.insertText", { text: chars[inserted] }, sessionId);
      inserted += 1;
    }
  });
}

async function pressKey(cdp, sessionId, key) {
  const keyInfo = keyEventInfo(key);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...keyInfo,
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...keyInfo,
  }, sessionId);
  await delay(150);
}

function keyEventInfo(key) {
  const normalized = String(key);
  const specials = {
    Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" },
    Tab: { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab" },
    Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
    Backspace: { windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" },
    ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp", key: "ArrowUp" },
    ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown", key: "ArrowDown" },
    ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft", key: "ArrowLeft" },
    ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight", key: "ArrowRight" },
  };
  return specials[normalized] || {
    windowsVirtualKeyCode: normalized.toUpperCase().charCodeAt(0),
    code: `Key${normalized.toUpperCase()}`,
    key: normalized,
    text: normalized.length === 1 ? normalized : undefined,
  };
}

async function waitForTarget(cdp, sessionId, target, timeoutSeconds) {
  const startedAt = Date.now();
  let lastError;
  while ((Date.now() - startedAt) / 1000 < timeoutSeconds) {
    try {
      await resolveElementBox(cdp, sessionId, target);
      return;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for ${targetDescription(target)}: ${lastError?.message || "not found"}`);
}

async function showHighlight(cdp, sessionId, target) {
  const box = await resolveElementBox(cdp, sessionId, target);
  await evaluate(cdp, sessionId, `
    (() => {
      const highlight = document.getElementById("__scroll_video_highlight");
      if (!highlight) return false;
      highlight.style.left = ${JSON.stringify(box.left)} + "px";
      highlight.style.top = ${JSON.stringify(box.top)} + "px";
      highlight.style.width = ${JSON.stringify(box.width)} + "px";
      highlight.style.height = ${JSON.stringify(box.height)} + "px";
      highlight.style.display = "block";
      return true;
    })()
  `);
}

async function hideHighlight(cdp, sessionId) {
  await evaluate(cdp, sessionId, `
    (() => {
      const highlight = document.getElementById("__scroll_video_highlight");
      if (highlight) highlight.style.display = "none";
      return true;
    })()
  `);
}

async function runScriptStep(cdp, sessionId, step, writer, options) {
  switch (step.action) {
    case "go":
      await openUrl(cdp, sessionId, step.url, options.delayMs);
      await setupScriptRuntime(cdp, sessionId, options);
      break;
    case "pause":
      await captureDurationFrames(cdp, sessionId, writer, options, step.seconds);
      break;
    case "scroll":
      await runScrollStep(cdp, sessionId, step, writer, options);
      break;
    case "click":
      await clickTarget(cdp, sessionId, step.target, options);
      break;
    case "type":
      await typeText(cdp, sessionId, step, writer, options);
      break;
    case "press":
      await pressKey(cdp, sessionId, step.key);
      break;
    case "wait":
      await waitForTarget(cdp, sessionId, step.target, step.timeout);
      break;
    case "zoom":
      await runZoomStep(cdp, sessionId, step, writer, options);
      break;
    case "highlight":
      await showHighlight(cdp, sessionId, step.target);
      await captureDurationFrames(cdp, sessionId, writer, options, step.duration);
      await hideHighlight(cdp, sessionId);
      break;
    default:
      throw new Error(`Unsupported cue action: ${step.action}`);
  }
}

async function runScrollStep(cdp, sessionId, step, writer, options) {
  const startY = await getCurrentScrollY(cdp, sessionId);
  const pageHeight = await getPageHeight(cdp, sessionId);
  const maxScroll = Math.max(0, pageHeight - options.height);
  let targetY;

  if (step.mode === "by") {
    if (typeof step.value === "object") {
      throw new Error("scroll by requires a numeric pixel value");
    }
    targetY = startY + Number(step.value);
  } else if (step.value === "bottom") {
    targetY = maxScroll;
  } else if (step.value === "top") {
    targetY = 0;
  } else if (typeof step.value === "object") {
    const box = await resolveElementBox(cdp, sessionId, step.value, {
      scrollIntoView: false,
    });
    targetY = startY + box.top + (box.height / 2) - (options.height / 2);
  } else {
    targetY = Number(step.value);
  }

  targetY = Math.max(0, Math.min(maxScroll, targetY));
  await captureDurationFrames(cdp, sessionId, writer, options, step.duration, async (progress) => {
    await scrollTo(cdp, sessionId, startY + ((targetY - startY) * progress));
  });
  await scrollTo(cdp, sessionId, targetY);
}

async function runZoomStep(cdp, sessionId, step, writer, options) {
  const startZoom = await getZoom(cdp, sessionId);
  if (!step.duration || step.duration <= 0) {
    await setZoom(cdp, sessionId, step.to);
    return;
  }
  await captureDurationFrames(cdp, sessionId, writer, options, step.duration, async (progress) => {
    await setZoom(cdp, sessionId, startZoom + ((step.to - startZoom) * progress));
  });
  await setZoom(cdp, sessionId, step.to);
}

function buildScrollPlan(maxScroll, options) {
  if (maxScroll <= 0) {
    return {
      positions: [0],
      durationSeconds: 1 / options.fps,
      effectiveSpeed: 0,
    };
  }

  const speed = options.duration
    ? maxScroll / options.duration
    : options.speed;
  const frameStep = speed / options.fps;
  const frameCount = Math.max(2, Math.ceil(maxScroll / frameStep) + 1);
  const positions = [];

  for (let index = 0; index < frameCount; index += 1) {
    positions.push(Math.min(maxScroll, index * frameStep));
  }
  positions[positions.length - 1] = maxScroll;

  const durationSeconds = positions.length / options.fps;
  return {
    positions,
    durationSeconds,
    effectiveSpeed: maxScroll / ((positions.length - 1) / options.fps),
  };
}

function startFfmpeg(options) {
  const ffmpeg = spawn(options.ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(options.fps),
    "-i",
    "pipe:0",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    options.out,
  ], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let stderr = "";
  ffmpeg.stderr.setEncoding("utf8");
  ffmpeg.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return { ffmpeg, getStderr: () => stderr };
}

async function writeFrame(ffmpeg, frame) {
  if (!ffmpeg.stdin.write(frame)) {
    await once(ffmpeg.stdin, "drain");
  }
}

async function waitForProcessExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return true;
  }

  return Promise.race([
    once(childProcess, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function captureFrame(cdp, sessionId) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  }, sessionId);
  return Buffer.from(data, "base64");
}

async function encodeScrollVideo(cdp, sessionId, plan, options) {
  const outputDir = dirname(options.out);
  if (!existsSync(outputDir)) {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }

  const { ffmpeg, getStderr } = startFfmpeg(options);
  console.log(
    `Capturing ${plan.positions.length} frames at ${options.width}x${options.height}, ${options.fps} fps`,
  );

  const progressEvery = Math.max(1, Math.floor(plan.positions.length / 20));
  for (let index = 0; index < plan.positions.length; index += 1) {
    await scrollTo(cdp, sessionId, plan.positions[index]);
    const frame = await captureFrame(cdp, sessionId);
    await writeFrame(ffmpeg, frame);

    if ((index + 1) % progressEvery === 0 || index + 1 === plan.positions.length) {
      const percent = Math.round(((index + 1) / plan.positions.length) * 100);
      console.log(`Progress: ${percent}%`);
    }
  }

  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, "close");
  if (code !== 0) {
    throw new Error(`ffmpeg failed with exit code ${code}:\n${getStderr()}`);
  }
}

function describeStep(step) {
  switch (step.action) {
    case "go":
      return `go ${step.url}`;
    case "pause":
      return `pause ${step.seconds}s`;
    case "scroll":
      return `scroll ${step.mode} ${typeof step.value === "object" ? targetDescription(step.value) : step.value} over ${step.duration}s`;
    case "click":
      return `click ${targetDescription(step.target)}`;
    case "type":
      return `type "${step.text}"`;
    case "press":
      return `press ${step.key}`;
    case "wait":
      return `wait for ${targetDescription(step.target)}`;
    case "zoom":
      return step.duration
        ? `zoom to ${step.to} over ${step.duration}s`
        : `zoom to ${step.to}`;
    case "highlight":
      return `highlight ${targetDescription(step.target)} for ${step.duration}s`;
    default:
      return step.action;
  }
}

async function encodeScriptVideo(cdp, sessionId, script, options) {
  const outputDir = dirname(options.out);
  if (!existsSync(outputDir)) {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }
  if (options.storyboardDir) {
    mkdirSync(options.storyboardDir, { recursive: true });
  }

  const writer = new VideoWriter(options);
  console.log(
    `Running ${script.steps.length} cue steps at ${options.width}x${options.height}, ${options.fps} fps`,
  );

  try {
    await setupScriptRuntime(cdp, sessionId, options);
    for (let index = 0; index < script.steps.length; index += 1) {
      const step = script.steps[index];
      console.log(`Step ${index + 1}/${script.steps.length}: ${describeStep(step)}`);
      await runScriptStep(cdp, sessionId, step, writer, options);
      await writeStoryboardFrame(cdp, sessionId, options, index, step);
    }
    await writer.finish();
  } catch (error) {
    writer.abort();
    await writeScriptErrorReport(cdp, sessionId, options, error);
    throw error;
  }
}

async function writeStoryboardFrame(cdp, sessionId, options, index, step) {
  if (!options.storyboardDir) {
    return;
  }
  const safeAction = step.action.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const filename = `${String(index + 1).padStart(3, "0")}-${safeAction}.png`;
  const frame = await captureFrame(cdp, sessionId);
  writeFileSync(join(options.storyboardDir, filename), frame);
}

async function writeScriptErrorReport(cdp, sessionId, options, error) {
  const base = options.out.replace(/\.[^.]+$/, "");
  const screenshotPath = `${base}.error.png`;
  const reportPath = `${base}.error.json`;
  let currentUrl = null;
  let screenshot = null;

  try {
    currentUrl = await evaluate(cdp, sessionId, "location.href");
  } catch {
    currentUrl = null;
  }
  try {
    screenshot = await captureFrame(cdp, sessionId);
    writeFileSync(screenshotPath, screenshot);
  } catch {
    screenshot = null;
  }

  writeFileSync(reportPath, JSON.stringify({
    message: error.message,
    url: currentUrl,
    screenshot: screenshot ? screenshotPath : null,
    output: options.out,
  }, null, 2));

  console.error(`Wrote error report: ${reportPath}`);
  if (screenshot) {
    console.error(`Wrote error screenshot: ${screenshotPath}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let browser;

  try {
    let script = null;
    if (options.scriptPath) {
      script = loadCueScript(options.scriptPath);
      mergeScriptOptions(options, script.options);
    }

    browser = await launchChrome(options);
    const sessionId = await createPage(browser.cdp, options);

    if (script) {
      await encodeScriptVideo(browser.cdp, sessionId, script, options);
      console.log(`Wrote ${options.out}`);
    } else {
      const page = await preparePage(browser.cdp, sessionId, options);
      const plan = buildScrollPlan(page.maxScroll, options);

      console.log(`Page height: ${page.pageHeight}px`);
      console.log(`Scroll distance: ${page.maxScroll}px`);
      console.log(`Video duration: ${plan.durationSeconds.toFixed(2)}s`);
      console.log(`Effective speed: ${Math.round(plan.effectiveSpeed)} px/s`);

      await encodeScrollVideo(browser.cdp, sessionId, plan, options);
      console.log(`Wrote ${options.out}`);
    }
  } finally {
    if (browser) {
      await browser.cdp.send("Browser.close").catch(() => {});
      browser.cdp.close();
      const exited = await waitForProcessExit(browser.chrome, 3000);
      if (!exited) {
        browser.chrome.kill("SIGTERM");
        await waitForProcessExit(browser.chrome, 3000);
      }
      if (!options.keepBrowser) {
        rmSync(browser.userDataDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } else {
        console.log(`Chrome profile kept at ${browser.userDataDir}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
