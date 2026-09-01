import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mediaDirectory = join(
  root,
  "docs",
  "hackathon-build",
  "submission-media",
);
const baseUrl = "https://guildhall.kimetsu-dev.workers.dev";
const width = 1600;
const height = 900;

const shots = [
  {
    id: "hero",
    file: "01-guildhall-hero.png",
    url: `${baseUrl}/`,
    ready: "#home-title",
    frame: "#home",
  },
  {
    id: "protocol",
    file: "02-protocol-anatomy.png",
    url: `${baseUrl}/`,
    ready: ".protocol-card-grid",
    frame: "#protocol .page-section-heading",
    hideHeader: true,
  },
  {
    id: "pact",
    file: "03-immutable-pact.png",
    url: `${baseUrl}/?event=14`,
    ready: ".hud-demo.chapter-pact",
    frame: "#mission-chamber",
  },
  {
    id: "failure",
    file: "04-verification-failure.png",
    url: `${baseUrl}/?event=42`,
    ready: ".hud-demo.chapter-mismatch",
    frame: "#mission-chamber",
  },
  {
    id: "correction",
    file: "05-bounded-correction.png",
    url: `${baseUrl}/?event=44`,
    ready: ".hud-demo.chapter-correction",
    frame: "#mission-chamber",
  },
  {
    id: "reward",
    file: "06-signed-reward.png",
    url: `${baseUrl}/?event=48`,
    ready: ".hud-demo.chapter-reward",
    frame: "#mission-chamber",
  },
  {
    id: "live",
    file: "07-live-guild.png",
    url: `${baseUrl}/`,
    ready: ".live-guild-section",
    frame: "#live-guild",
  },
];

const requestedIds = new Set(process.argv.slice(2));
const selectedShots =
  requestedIds.size === 0
    ? shots
    : shots.filter((shot) => requestedIds.has(shot.id));

async function main() {
  if (selectedShots.length === 0) {
    throw new Error(
      `No matching shots. Choose from: ${shots.map((shot) => shot.id).join(", ")}`,
    );
  }

  await mkdir(mediaDirectory, { recursive: true });

  const chromePath = await findChrome();
  const profileDirectory = join(
    tmpdir(),
    `guildhall-shot-${Date.now()}-${process.pid}`,
  );
  await mkdir(profileDirectory, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let chromeErrors = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeErrors = `${chromeErrors}${chunk}`.slice(-8_000);
  });

  let client;
  try {
    const port = await waitForDevToolsPort(profileDirectory);
    const target = await waitForPageTarget(port);
    client = await CdpClient.connect(target.webSocketDebuggerUrl);

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const shot of selectedShots) {
      const loaded = client.waitForEvent("Page.loadEventFired", 30_000);
      const navigation = await client.send("Page.navigate", { url: shot.url });
      if (navigation.errorText) {
        throw new Error(`Could not open ${shot.url}: ${navigation.errorText}`);
      }
      await loaded;
      await waitForSelector(client, shot.ready, 30_000);
      await prepareFrame(client, shot.frame, shot.hideHeader === true);

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const destination = join(mediaDirectory, shot.file);
      await writeFile(destination, Buffer.from(screenshot.data, "base64"));
      process.stdout.write(`${shot.id}: ${destination}\n`);
    }
  } catch (error) {
    if (chromeErrors.trim().length > 0) {
      process.stderr.write(`${chromeErrors.trim()}\n`);
    }
    throw error;
  } finally {
    client?.close();
    if (!chrome.killed) chrome.kill();
    await safelyRemoveProfile(profileDirectory);
  }
}

async function findChrome() {
  const configured = process.env.GUILDHALL_CHROME_PATH;
  const candidates = [
    configured,
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? join(
          process.env.LOCALAPPDATA,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error(
    "Chrome was not found. Set GUILDHALL_CHROME_PATH to chrome.exe.",
  );
}

async function waitForDevToolsPort(profileDirectory) {
  const portFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/u);
      if (port) return Number(port);
    } catch {
      // Chrome creates the file after its debugging server is ready.
    }
    await delay(100);
  }
  throw new Error("Chrome did not expose a debugging port within 15 seconds.");
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (page) return page;
    } catch {
      // Retry while the initial target is created.
    }
    await delay(100);
  }
  throw new Error("Chrome did not expose a page target within 15 seconds.");
}

async function waitForSelector(client, selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function prepareFrame(client, selector, hideHeader) {
  const headerRule = hideHeader
    ? ".site-shell-header { display: none !important; }"
    : [
        ".site-shell-header {",
        "  position: fixed !important;",
        "  inset: 0 0 auto 0 !important;",
        "  transform: none !important;",
        "}",
      ].join("\\n");
  const styleResult = await client.send("Runtime.evaluate", {
    expression: `(() => {
    let style = document.querySelector("style[data-submission-capture]");
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement("style");
      style.dataset.submissionCapture = "true";
      document.head.appendChild(style);
    }
    style.textContent = [
      "html { scroll-behavior: auto !important; }",
      "html, body { overflow-anchor: none !important; }",
      ${JSON.stringify(headerRule)},
      "*, *::before, *::after {",
      "  animation-delay: 0s !important;",
      "  animation-duration: 0.001s !important;",
      "  transition-delay: 0s !important;",
      "  transition-duration: 0s !important;",
      "  caret-color: transparent !important;",
      "}",
    ].join("\\n");
    return true;
  })()`,
    returnByValue: true,
  });
  if (styleResult.result?.value !== true) {
    throw new Error("Could not prepare submission capture styles.");
  }

  await delay(100);
  const scrollExpression = `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    const header = document.querySelector(".site-shell-header");
    const headerHeight = header instanceof HTMLElement ? header.offsetHeight : 0;
    const top = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - headerHeight - 24));
    return true;
  })()`;

  for (const pause of [400, 150]) {
    const result = await client.send("Runtime.evaluate", {
      expression: scrollExpression,
      returnByValue: true,
    });
    if (result.result?.value !== true) {
      throw new Error(`Could not frame ${selector}`);
    }
    await delay(pause);
  }
}

async function safelyRemoveProfile(profileDirectory) {
  const tempRoot = resolve(tmpdir());
  const target = resolve(profileDirectory);
  if (
    !target.startsWith(`${tempRoot}${sep}`) ||
    !basename(target).startsWith("guildhall-shot-")
  ) {
    throw new Error(`Refusing to remove unexpected profile path: ${target}`);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener(
        "error",
        () => rejectOpen(new Error("Could not connect to Chrome debugging.")),
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, {
        resolve: resolveResponse,
        reject: rejectResponse,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  waitForEvent(method, timeout) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.eventWaiters.delete(method);
        rejectEvent(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.eventWaiters.set(method, (params) => {
        clearTimeout(timer);
        resolveEvent(params);
      });
    });
  }

  close() {
    this.socket.close();
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${message.error.message} (${message.error.code})`),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    const waiter = this.eventWaiters.get(message.method);
    if (waiter) {
      this.eventWaiters.delete(message.method);
      waiter(message.params ?? {});
    }
  }
}

await main();
