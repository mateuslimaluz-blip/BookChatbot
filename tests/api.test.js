import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { MAX_QUERY_CHARS } from '../src/services/ragService.js';

test('Fastify API Routes', async (t) => {
  const app = buildApp();

  await t.test('GET /health deve retornar status 200 e { status: "ok" }', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.ok(body.timestamp);
  });

  await t.test('GET /ready deve responder com status de conectividade do banco', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    // Se o banco estiver ativo retorna 200, caso contrário 503
    assert.ok(response.statusCode === 200 || response.statusCode === 503);
    const body = JSON.parse(response.body);
    assert.ok(body.status);
    assert.ok(body.database);
  });

  await t.test('POST /books/:id/ingest com ID não-UUID deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/books/id-invalido-123/ingest',
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.ok(errorMsg);
  });

  await t.test('POST /chat/search sem query deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/search',
      payload: {},
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.match(errorMsg, /query/);
  });

  await t.test('POST /chat/search com bookId inválido deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/search',
      payload: {
        query: 'Quem é Bentinho?',
        bookId: 'nao-e-uuid',
      },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.ok(errorMsg);
  });

  await t.test('POST /chat sem query deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: {},
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.match(errorMsg, /query/);
  });

  await t.test('POST /chat com query excessivamente longa deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: {
        query: 'x'.repeat(MAX_QUERY_CHARS + 1),
      },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.ok(errorMsg);
  });

  await t.test('POST /chat com bookId não-UUID deve retornar status 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: {
        query: 'Qual é o enredo?',
        bookId: 'nao-e-uuid',
      },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    const errorMsg = typeof body.error === 'object' ? body.error.message : body.error;
    assert.ok(errorMsg);
  });
});
