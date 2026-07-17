import net from "node:net";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Persistent TCP connection to the mcp_listener.py script running inside
 * Rhino 8. Speaks newline-delimited JSON: {id, method, params} -> {id, result}
 * or {id, error: {message, traceback}}.
 */
export class RhinoBridge {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private host = "127.0.0.1",
    private port = 8765,
  ) {}

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setNoDelay(true);

      const onConnectError = (err: Error) => {
        this.connecting = null;
        reject(
          new Error(
            `Could not reach the Rhino listener on ${this.host}:${this.port} (${err.message}). ` +
              `Make sure Rhino 8 is open and the listener is running: in Rhino run the ` +
              `"ScriptEditor" command, open rhino/mcp_listener.py from this project, and press Run (F5). ` +
              `The listener keeps running in the background until Rhino closes.`,
          ),
        );
      };
      sock.once("error", onConnectError);

      sock.once("connect", () => {
        sock.removeListener("error", onConnectError);
        this.socket = sock;
        this.connecting = null;

        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("error", () => {
          /* handled by close */
        });
        sock.on("close", () => {
          this.socket = null;
          this.failAll(new Error("Connection to Rhino was closed."));
        });
        resolve(sock);
      });
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const detail = msg.error.traceback
          ? `${msg.error.message}\n${msg.error.traceback}`
          : String(msg.error.message ?? msg.error);
        p.reject(new Error(detail));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<any> {
    const sock = await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Rhino did not answer '${method}' within ${timeoutMs / 1000}s. ` +
              `Rhino may be busy computing, or a modal dialog may be open on screen.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}
