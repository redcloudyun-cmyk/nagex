import assert from 'node:assert';
import test from 'node:test';
import http from 'node:http';
import { OpenAIImageAdapter } from '../src/creation/providers/adapters/openai-image-adapter.js';

test('20. OpenAIImageAdapter - successful binary normalization (url -> Buffer)', async () => {
  let capturedPayload: any;
  const server = http.createServer((req, res) => {
    if (req.url === '/images/generations') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        capturedPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ url: `http://localhost:${(server.address() as any).port}/mock-image.png` }]
        }));
      });
    } else if (req.url === '/mock-image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('fake-image-bytes'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const adapter = new OpenAIImageAdapter({ apiKey: 'test-key', baseUrl: `http://localhost:${port}` });
    const result = await adapter.generateImage({
      creationKind: 'IMAGE',
      subject: 'Test subject',
      requestId: 'req_1'
    } as any);

    assert.equal(result.status, 'COMPLETED');
    if (result.status === 'COMPLETED') {
      assert.equal(result.output?.mimeType, 'image/png');
      assert.equal(result.output?.imageBuffer?.toString(), 'fake-image-bytes');
    }
    assert.equal(capturedPayload.model, 'gpt-image-2.5-flare');
    assert.equal(capturedPayload.response_format, undefined, 'Must not send response_format (defaults to url)');
  } finally {
    server.close();
  }
});

test('21. OpenAIImageAdapter - truthful capability declaration', () => {
  const adapter = new OpenAIImageAdapter({ apiKey: 'test-key' });
  const caps = adapter.getCapabilities();
  assert.equal(caps.textToImage, true);
  assert.equal(caps.imageToImage, false, 'Do not advertise unsupported capabilities');
  assert.equal(caps.editingInpainting, false);
  assert.equal(caps.referenceImageConditioning, false);
});

test('22. OpenAIImageAdapter - malformed provider response fails', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ something_else: 'value' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const adapter = new OpenAIImageAdapter({ apiKey: 'test-key', baseUrl: `http://localhost:${port}` });
    const result = await adapter.generateImage({ creationKind: 'IMAGE', subject: 'Test subject', requestId: 'req_1' } as any);
    assert.equal(result.status, 'FAILED');
    if (result.status === 'FAILED') {
      assert.equal(result.errorCode, 'EMPTY_PROVIDER_RESULT');
    }
  } finally {
    server.close();
  }
});

test('23. OpenAIImageAdapter - provider HTTP error', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Bad request content_policy' } }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const adapter = new OpenAIImageAdapter({ apiKey: 'test-key', baseUrl: `http://localhost:${port}` });
    const result = await adapter.generateImage({ creationKind: 'IMAGE', subject: 'Test subject', requestId: 'req_1' } as any);
    assert.equal(result.status, 'FAILED');
    if (result.status === 'FAILED') {
      assert.equal(result.errorCode, 'CONTENT_REJECTED');
    }
  } finally {
    server.close();
  }
});

test('24. OpenAIImageAdapter - empty binary fails', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/images/generations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `http://localhost:${(server.address() as any).port}/mock-image.png` }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.alloc(0)); // empty
    }
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const adapter = new OpenAIImageAdapter({ apiKey: 'test-key', baseUrl: `http://localhost:${port}` });
    const result = await adapter.generateImage({ creationKind: 'IMAGE', subject: 'Test subject', requestId: 'req_1' } as any);
    assert.equal(result.status, 'FAILED');
    if (result.status === 'FAILED') {
      assert.equal(result.errorCode, 'EMPTY_BINARY');
    }
  } finally {
    server.close();
  }
});

test('25. OpenAIImageAdapter - explicit modelId option overrides default', () => {
  const adapter = new OpenAIImageAdapter({ apiKey: 'test-key', modelId: 'gpt-image-2.5-sunburst' });
  // The adapter should use the explicitly provided model
  assert.equal((adapter as any).modelId, 'gpt-image-2.5-sunburst');
});

test('26. OpenAIImageAdapter - NAGEX_IMAGE_OPENAI_MODEL env overrides default', () => {
  const originalEnv = process.env.NAGEX_IMAGE_OPENAI_MODEL;
  try {
    process.env.NAGEX_IMAGE_OPENAI_MODEL = 'custom-model-override';
    const adapter = new OpenAIImageAdapter({ apiKey: 'test-key' });
    assert.equal((adapter as any).modelId, 'custom-model-override');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.NAGEX_IMAGE_OPENAI_MODEL;
    } else {
      process.env.NAGEX_IMAGE_OPENAI_MODEL = originalEnv;
    }
  }
});

test('27. OpenAIImageAdapter - canonical default model is gpt-image-2.5-flare', () => {
  const adapter = new OpenAIImageAdapter({ apiKey: 'test-key' });
  assert.equal((adapter as any).modelId, 'gpt-image-2.5-flare');
});
