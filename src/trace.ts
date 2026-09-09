import type { TraceEvent } from "./llm/types.js";

export interface TraceRun {
  id: string;
  label?: string;
  model?: string;
  prompt?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status: "running" | "done" | "error";
  error?: string;
  finalText?: string;
  events: TraceEvent[];
}

export interface TraceSnapshot { runs: TraceRun[]; }
type Listener = () => void;

export class TraceStore {
  private runsByClient = new Map<string, TraceRun[]>();
  private listeners = new Map<string, Set<Listener>>();

  private runs(clientId: string): TraceRun[] {
    let list = this.runsByClient.get(clientId);
    if (!list) { list = []; this.runsByClient.set(clientId, list); }
    return list;
  }

  route(clientId: string, ev: TraceEvent): void {
    const list = this.runs(clientId);
    if (ev.kind === "run-start") {
      list.push({
        id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        label: ev.label,
        model: ev.model,
        prompt: ev.prompt,
        startedAt: ev.timestamp,
        status: "running",
        events: [ev],
      });
      if (list.length > 30) list.splice(0, list.length - 30);
    } else {
      const run = list[list.length - 1];
      if (!run) return;
      run.events.push(ev);
      if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
      if (ev.kind === "run-end") {
        run.status = "done"; run.finishedAt = ev.timestamp;
        run.durationMs = ev.durationMs; run.finalText = ev.finalText;
      } else if (ev.kind === "run-error") {
        run.status = "error"; run.finishedAt = ev.timestamp;
        run.durationMs = ev.durationMs; run.error = ev.error;
      }
    }
    this.notify(clientId);
  }

  snapshot(clientId: string): TraceSnapshot {
    return { runs: (this.runsByClient.get(clientId) ?? []).map((run) => ({ ...run, events: [...run.events] })) };
  }

  subscribe(clientId: string, listener: Listener): () => void {
    let set = this.listeners.get(clientId);
    if (!set) { set = new Set(); this.listeners.set(clientId, set); }
    set.add(listener);
    return () => { set?.delete(listener); if (set?.size === 0) this.listeners.delete(clientId); };
  }

  clear(clientId: string): void { this.runsByClient.delete(clientId); this.notify(clientId); }

  private notify(clientId: string): void {
    for (const listener of [...(this.listeners.get(clientId) ?? [])]) {
      try { listener(); } catch { /* tracing must never break a request */ }
    }
  }
}