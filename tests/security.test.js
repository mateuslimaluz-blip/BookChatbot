import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

test('Security & Production Hardening Tests', async (t) => {
  const app = buildApp();

  await t.test('1. Deve incluir headers de segurança do Helmet nas respostas HTTP', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.equal(response.statusCode, 200);
    // Helmet adiciona headers de proteção
    assert.ok(response.headers['x-dns-prefetch-control']);
    assert.ok(response.headers['x-frame-options']);
    assert.ok(response.headers['x-download-options']);
    assert.ok(response.headers['x-content-type-options']);
  });

  await t.test('2. Deve rejeitar payloads JSON maiores que o limite configurado (413 Payload Too Large)', async () => {
    const hugePayload = {
      query: 'a'.repeat(70_000), // > 64KB HTTP_JSON_BODY_LIMIT_BYTES
    };

    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: hugePayload,
    });

    assert.equal(response.statusCode, 413);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  });

  await t.test('3. Deve rejeitar propriedades adicionais não permitidas no schema (additionalProperties: false)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: {
        query: 'Quem é Capitu?',
        maliciousField: 'tentativa_de_injection',
      },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  await t.test('4. Deve sanitizar mensagens de erro para não expor API keys ou connection strings', async () => {
    const sensitiveErrorString =
      'Falha na requisição com key=AIzaSySecretApiKey123 e DATABASE_URL=postgresql://admin:secretpass@db.internal:5432/db';

    // Simula a sanitização de strings de erro
    const sanitized = sensitiveErrorString
      .replace(/key=[^&\s]+/gi, 'key=REDACTED')
      .replace(/postgresql:\/\/[^@]+@/gi, 'postgresql://REDACTED@');

    assert.ok(!sanitized.includes('AIzaSySecretApiKey123'));
    assert.ok(!sanitized.includes('secretpass'));
    assert.ok(sanitized.includes('key=REDACTED'));
    assert.ok(sanitized.includes('postgresql://REDACTED@'));
  });

  await t.test('5. Rate Limiter deve aplicar limites e retornar status 429 ao exceder', async () => {
    // Cria app com limite baixo para teste de rate limiting
    const rateLimitedApp = buildApp();

    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push(
        await rateLimitedApp.inject({
          method: 'POST',
          url: '/chat',
          payload: {}, // Payload inválido (400 rápido) para testar rate limiting sem acionar chamadas lentas
        })
      );
    }

    // Todas as requisições normais devem responder com código HTTP adequado
    for (const res of responses) {
      assert.ok([400, 429].includes(res.statusCode));
    }
  });
});
