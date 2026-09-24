// The few Workers runtime APIs the Worker uses, declared here rather than
// pulling in all of @cloudflare/workers-types, whose globals clash with the DOM's.

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: unknown;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
}

/** A Worker's WebSocket: the server end has to be accepted before it can be used. */
interface WebSocket {
  accept(): void;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket;
}
