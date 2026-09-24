/**
 * Server-sent-event decoding and OpenAI-compatible payload parsing.
 *
 * Deliberately free of any `vscode` import so it can be exercised by plain Node
 * outside the extension host.
 */

export const SSE_DONE_SENTINEL = '[DONE]';

export interface SseEvent {
  event: string | null;
  data: string;
}

export interface ChatStreamDelta {
  content: string;
  model: string | null;
  totalTokens: number | null;
  error: string | null;
}

export interface ChatCompletionResult {
  content: string;
  model: string | null;
  totalTokens: number;
}

/** One model as advertised by a provider's `/models` endpoint. */
export interface ModelDescriptor {
  id: string;
  ownedBy: string | null;
  contextLength: number | null;
}

/**
 * Accumulates network chunks and emits whole SSE frames. Network reads split at
 * arbitrary byte offsets, so a frame routinely arrives across several pushes.
 */
export class SseDecoder {
  private pending = '';

  push(chunk: string): SseEvent[] {
    this.pending += normalizeLineEndings(chunk);

    const events: SseEvent[] = [];
    let separatorIndex = this.pending.indexOf('\n\n');

    while (separatorIndex !== -1) {
      const frame = this.pending.slice(0, separatorIndex);
      this.pending = this.pending.slice(separatorIndex + 2);

      const decoded = decodeFrame(frame);
      if (decoded !== null) {
        events.push(decoded);
      }

      separatorIndex = this.pending.indexOf('\n\n');
    }

    return events;
  }

  /** Drains a trailing frame that was never terminated by a blank line. */
  flush(): SseEvent[] {
    const remainder = this.pending;
    this.pending = '';

    if (remainder.trim().length === 0) {
      return [];
    }

    const decoded = decodeFrame(remainder);
    return decoded === null ? [] : [decoded];
  }
}

function normalizeLineEndings(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeFrame(frame: string): SseEvent | null {
  const dataLines: string[] = [];
  let eventName: string | null = null;

  for (const line of frame.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }

    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);

    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      eventName = value;
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event: eventName, data: dataLines.join('\n') };
}

/**
 * Returns null for the terminating sentinel and for anything that is not valid
 * JSON, since providers intersperse keep-alive and vendor-specific frames.
 */
export function parseChatStreamPayload(payload: string): ChatStreamDelta | null {
  if (payload.trim() === SSE_DONE_SENTINEL) {
    return null;
  }

  const envelope = parseJsonObject(payload);
  if (envelope === null) {
    return null;
  }

  return {
    content: readStreamDeltaContent(envelope),
    model: readModel(envelope),
    totalTokens: readTotalTokens(envelope),
    error: readError(envelope),
  };
}

export function parseChatCompletion(body: unknown): ChatCompletionResult {
  const envelope = asRecord(body);
  if (envelope === null) {
    throw new Error('Provider returned a response that was not a JSON object.');
  }

  const error = readError(envelope);
  if (error !== null) {
    throw new Error(error);
  }

  return {
    content: readMessageContent(envelope),
    model: readModel(envelope),
    totalTokens: readTotalTokens(envelope) ?? 0,
  };
}

function readStreamDeltaContent(envelope: Record<string, unknown>): string {
  const choice = readFirstChoice(envelope);
  if (choice === null) {
    return '';
  }

  const delta = asRecord(choice.delta);
  if (delta === null) {
    return '';
  }

  return typeof delta.content === 'string' ? delta.content : '';
}

function readMessageContent(envelope: Record<string, unknown>): string {
  const choice = readFirstChoice(envelope);
  if (choice === null) {
    return '';
  }

  const message = asRecord(choice.message);
  if (message === null) {
    return '';
  }

  return typeof message.content === 'string' ? message.content : '';
}

function readFirstChoice(envelope: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(envelope.choices) || envelope.choices.length === 0) {
    return null;
  }

  return asRecord(envelope.choices[0]);
}

function readModel(envelope: Record<string, unknown>): string | null {
  return typeof envelope.model === 'string' && envelope.model.length > 0 ? envelope.model : null;
}

function readTotalTokens(envelope: Record<string, unknown>): number | null {
  const usage = asRecord(envelope.usage);
  if (usage === null) {
    return null;
  }

  return typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
}

function readError(envelope: Record<string, unknown>): string | null {
  const error = envelope.error;

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  const errorRecord = asRecord(error);
  if (errorRecord === null) {
    return null;
  }

  return typeof errorRecord.message === 'string' && errorRecord.message.length > 0
    ? errorRecord.message
    : 'Provider reported an unspecified error.';
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads `data[]` from an OpenAI-compatible catalog, tolerating extra vendor fields. */
export function parseModelCatalog(body: unknown): ModelDescriptor[] {
  const container = body as { data?: unknown } | null;
  const entries = Array.isArray(container?.data) ? container.data : body;

  if (!Array.isArray(entries)) {
    return [];
  }

  const models: ModelDescriptor[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      models.push({ id: entry, ownedBy: null, contextLength: null });
      continue;
    }

    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : '';

    if (id.length === 0) {
      continue;
    }

    const contextLength = [raw.context_length, raw.context_window, raw.max_context_length]
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value));

    models.push({
      id,
      ownedBy: typeof raw.owned_by === 'string' ? raw.owned_by : null,
      contextLength: contextLength ?? null,
    });
  }

  return models.sort((left, right) => left.id.localeCompare(right.id));
}
