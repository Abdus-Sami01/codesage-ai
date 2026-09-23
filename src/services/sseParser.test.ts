import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SseDecoder,
  parseChatCompletion,
  parseChatStreamPayload,
} from './sseParser';

test('emits a frame only once its blank-line terminator arrives', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data: {"a":1}'), []);
  assert.deepEqual(decoder.push('\n\n'), [{ event: null, data: '{"a":1}' }]);
});

test('reassembles a frame split mid-token across three network reads', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data: {"cho'), []);
  assert.deepEqual(decoder.push('ices":[{"delta":{"con'), []);

  assert.deepEqual(decoder.push('tent":"hi"}}]}\n\n'), [
    { event: null, data: '{"choices":[{"delta":{"content":"hi"}}]}' },
  ]);
});

test('accepts CRLF frame separators', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data: one\r\n\r\ndata: two\r\n\r\n'), [
    { event: null, data: 'one' },
    { event: null, data: 'two' },
  ]);
});

test('skips comment and keep-alive lines', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push(': ping\n\ndata: real\n\n'), [
    { event: null, data: 'real' },
  ]);
});

test('joins multiple data lines within one frame using newlines', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data: first\ndata: second\n\n'), [
    { event: null, data: 'first\nsecond' },
  ]);
});

test('captures a named event field', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('event: usage\ndata: {}\n\n'), [
    { event: 'usage', data: '{}' },
  ]);
});

test('strips exactly one leading space after the field colon', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data:  padded\n\n'), [
    { event: null, data: ' padded' },
  ]);
});

test('flush drains an unterminated trailing frame', () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push('data: tail'), []);
  assert.deepEqual(decoder.flush(), [{ event: null, data: 'tail' }]);
  assert.deepEqual(decoder.flush(), []);
});

test('flush ignores trailing whitespace', () => {
  const decoder = new SseDecoder();

  decoder.push('data: done\n\n');
  assert.deepEqual(decoder.flush(), []);
});

test('treats the DONE sentinel as end of stream', () => {
  assert.equal(parseChatStreamPayload('[DONE]'), null);
  assert.equal(parseChatStreamPayload(' [DONE] '), null);
});

test('ignores payloads that are not valid JSON objects', () => {
  assert.equal(parseChatStreamPayload('not json'), null);
  assert.equal(parseChatStreamPayload('[1,2,3]'), null);
});

test('extracts delta content from a streaming chunk', () => {
  const delta = parseChatStreamPayload(
    '{"model":"m-1","choices":[{"delta":{"content":"chunk"}}]}'
  );

  assert.deepEqual(delta, {
    content: 'chunk',
    model: 'm-1',
    totalTokens: null,
    error: null,
  });
});

test('reports empty content for a role-only opening chunk', () => {
  const delta = parseChatStreamPayload('{"choices":[{"delta":{"role":"assistant"}}]}');

  assert.equal(delta?.content, '');
});

test('reports empty content when choices is absent or empty', () => {
  assert.equal(parseChatStreamPayload('{}')?.content, '');
  assert.equal(parseChatStreamPayload('{"choices":[]}')?.content, '');
});

test('reads usage from a terminal usage chunk', () => {
  const delta = parseChatStreamPayload('{"choices":[],"usage":{"total_tokens":1234}}');

  assert.equal(delta?.totalTokens, 1234);
});

test('surfaces a streamed error envelope', () => {
  const delta = parseChatStreamPayload('{"error":{"message":"rate limited"}}');

  assert.equal(delta?.error, 'rate limited');
});

test('surfaces a bare string error envelope', () => {
  assert.equal(parseChatStreamPayload('{"error":"boom"}')?.error, 'boom');
});

test('parses a non-streaming completion', () => {
  const completion = parseChatCompletion({
    model: 'm-2',
    choices: [{ message: { content: 'full body' } }],
    usage: { total_tokens: 42 },
  });

  assert.deepEqual(completion, { content: 'full body', model: 'm-2', totalTokens: 42 });
});

test('defaults completion token usage to zero when the provider omits it', () => {
  const completion = parseChatCompletion({ choices: [{ message: { content: 'x' } }] });

  assert.equal(completion.totalTokens, 0);
  assert.equal(completion.model, null);
});

test('throws when a completion carries an error envelope', () => {
  assert.throws(
    () => parseChatCompletion({ error: { message: 'invalid api key' } }),
    /invalid api key/
  );
});

test('throws when a completion body is not an object', () => {
  assert.throws(() => parseChatCompletion('nope'), /not a JSON object/);
});
