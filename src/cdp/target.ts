const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TARGET_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export function validatedDebuggerUrl(target: CdpTarget, port: number): string {
  if (
    target.type !== "page"
    || !target.url.startsWith("app://")
    || !TARGET_ID_PATTERN.test(target.id)
  ) {
    throw new Error("Rejected a non-Codex CDP target");
  }

  const url = new URL(target.webSocketDebuggerUrl);
  const validPath = new RegExp(`^/devtools/page/${target.id.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&")}$`);
  if (
    url.protocol !== "ws:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || Number(url.port) !== port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !validPath.test(url.pathname)
  ) {
    throw new Error("Rejected a CDP endpoint outside the loopback page target");
  }
  return url.href;
}

export async function discoverAppTargets(port: number): Promise<CdpTarget[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new Error(`无法连接本机 CDP 端口 ${port}`);
    }
    if (!response.ok) throw new Error(`CDP 目标发现返回 HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("CDP 目标发现返回了无效数据");
    const targets: CdpTarget[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Partial<CdpTarget>;
      if (
        typeof candidate.id !== "string"
        || typeof candidate.type !== "string"
        || typeof candidate.url !== "string"
        || typeof candidate.webSocketDebuggerUrl !== "string"
      ) continue;
      const target = candidate as CdpTarget;
      try {
        validatedDebuggerUrl(target, port);
        targets.push(target);
      } catch {
        continue;
      }
    }
    return targets;
  } finally {
    clearTimeout(timeout);
  }
}
