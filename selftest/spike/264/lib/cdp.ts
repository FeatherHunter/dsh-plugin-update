/**
 * T0 spike 的最小 CDP 客户端（throwaway —— 思路抄自 dsh-prompt scripts/real/harness/cdp.mjs）。
 * 零第三方依赖：用 Node 22+ 自带的全局 WebSocket，只碰公开协议 Page / Runtime / Input。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT = 30_000;

function describeException(details: any): string {
  if (!details) return 'unknown';
  const ex = details.exception ?? {};
  if (typeof ex.description === 'string' && ex.description) return ex.description;
  if (typeof ex.value === 'string' && ex.value) return ex.value;
  if (typeof details.text === 'string' && details.text) return details.text;
  return JSON.stringify(details).slice(0, 800);
}

export async function listTargets(cdpPort: number, timeoutMs = 10_000): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:' + cdpPort + '/json/list', { signal: controller.signal });
    if (!res.ok) throw new Error('CDP /json/list HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function connect({ cdpPort, timeoutMs = 15_000, onEvent = null }: { cdpPort: number; timeoutMs?: number; onEvent?: ((message: any) => void) | null }) {
  const targets = await listTargets(cdpPort, timeoutMs);
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('CDP 没有页面目标：' + JSON.stringify(targets).slice(0, 400));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WS 连接超时')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP WS 失败：' + String(e?.message ?? e))); });
  });

  let nextId = 1;
  const pending = new Map<number, any>();
  const opened = Date.now();

  ws.addEventListener('message', (event: any) => {
    let message: any;
    try {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      message = JSON.parse(raw);
    } catch { return; }
    if (message.id != null) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error('CDP ' + entry.method + '：' + (message.error.message ?? JSON.stringify(message.error))));
      else entry.resolve(message.result ?? {});
      return;
    }
    // 非请求响应 = CDP 事件（Runtime.consoleAPICalled / exceptionThrown / Log.entryAdded 等）。
    // 默认丢弃；传 onEvent 时交给调用方收集，用于「页面 console 原始证据」。
    if (typeof onEvent === 'function') {
      try { onEvent(message); } catch { /* 收集器自身异常不影响驱动 */ }
    }
  });

  function send(method: string, params: any = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 调用超时：' + method)); }, timeoutMs);
      pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function evaluate(expression: string): Promise<any> {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error('页面内执行失败：' + describeException(result.exceptionDetails) + ' | expr=' + String(expression).slice(0, 300));
    return result.result ? result.result.value : undefined;
  }

  async function waitFor(expression: string, { timeoutMs = 8_000, pollMs = 100, label = '' }: { timeoutMs?: number; pollMs?: number; label?: string } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleepMs(pollMs);
    }
    throw new Error('等待超时(' + timeoutMs + 'ms)：' + (label || String(expression).slice(0, 200)) + '；最后取值=' + JSON.stringify(last));
  }

  async function navigate(url: string, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}) {
    await send('Page.enable', {}, timeoutMs);
    await send('Page.navigate', { url }, timeoutMs);
    const base = String(url).split('?')[0];
    await waitFor('location.href.indexOf(' + JSON.stringify(base) + ') === 0 && document.readyState === "complete"', { timeoutMs, label: '页面加载完成' });
  }

  async function getRect(selector: string): Promise<any> {
    return await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()');
  }

  async function mouseMove(x: number, y: number): Promise<void> {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  }

  async function click(x: number, y: number, { clickCount = 1 }: { clickCount?: number } = {}) {
    await mouseMove(x, y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  }

  async function clickSelector(selector: string) {
    const rect = await getRect(selector);
    if (!rect) throw new Error('页面上找不到元素：' + selector);
    await click(rect.cx, rect.cy);
    return rect;
  }

  async function screenshot(filePath: string, clip?: any) {
    const params = { format: 'png', fromSurface: true };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
    const result = await send('Page.captureScreenshot', params);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async function close() { try { ws.close(); } catch { /* closed */ } await sleepMs(200); }

  return { cdpPort, pageTarget: page, send, evaluate, waitFor, navigate, getRect, mouseMove, click, clickSelector, screenshot, close, openedAt: opened };
}
