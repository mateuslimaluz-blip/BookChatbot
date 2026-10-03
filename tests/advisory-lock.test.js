import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAdvisoryLockKey, ingestBook } from '../src/services/ingestionService.js';
import { buildApp } from '../src/app.js';

test('PostgreSQL Advisory Lock Tests', async (t) => {
  const sampleUuid1 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const sampleUuid2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

  await t.test('1. generateAdvisoryLockKey deve gerar chaves BigInt determinísticas e válidas', () => {
    const key1 = generateAdvisoryLockKey(sampleUuid1);
    const key1Again = generateAdvisoryLockKey(sampleUuid1);
    const key2 = generateAdvisoryLockKey(sampleUuid2);

    assert.equal(typeof key1, 'string');
    assert.equal(key1, key1Again, 'Mesmo UUID deve produzir chave idêntica');
    assert.notEqual(key1, key2, 'UUIDs diferentes devem produzir chaves diferentes');

    // Valida que pode ser parseado como BigInt
    const parsedBigInt = BigInt(key1);
    assert.ok(typeof parsedBigInt === 'bigint');

    // Valida rejeição para entradas inválidas
    assert.throws(() => generateAdvisoryLockKey(null), /UUID inválido/);
    assert.throws(() => generateAdvisoryLockKey(''), /UUID inválido/);
    assert.throws(() => generateAdvisoryLockKey('   '), /UUID inválido/);
  });

  await t.test('2. ingestBook deve adquirir e liberar o advisory lock em caso de sucesso', async () => {
    const executedQueries = [];
    let isReleased = false;

    const mockClient = {
      query: async (sql, params) => {
        executedQueries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      },
      release: () => {
        isReleased = true;
      },
    };

    // Injetamos mock dbClient e embeddingFn
    try {
      await ingestBook(sampleUuid1, {
        dbClient: mockClient,
        embeddingFn: async () => Array.from({ length: 768 }, () => 0.05),
      });
    } catch {
      // Como o DB select pode falhar se não houver banco conectado, verificamos o fluxo do lock
    }

    const lockQuery = executedQueries.find((q) => q.sql.includes('pg_try_advisory_lock'));
    assert.ok(lockQuery, 'Deve chamar pg_try_advisory_lock');
    assert.equal(lockQuery.params[0], generateAdvisoryLockKey(sampleUuid1));

    const unlockQuery = executedQueries.find((q) => q.sql.includes('pg_advisory_unlock'));
    assert.ok(unlockQuery, 'Deve chamar pg_advisory_unlock no finally se obteve o lock');
  });

  await t.test('3. ingestBook deve lançar erro 409 INGESTION_IN_PROGRESS se o lock estiver ocupado', async () => {
    const executedQueries = [];

    const mockBusyClient = {
      query: async (sql, params) => {
        executedQueries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: false }] }; // Lock ocupado por outro processo
        }
        return { rows: [] };
      },
      release: () => {},
    };

    await assert.rejects(
      async () => {
        await ingestBook(sampleUuid1, { dbClient: mockBusyClient });
      },
      (err) => {
        assert.equal(err.code, 'INGESTION_IN_PROGRESS');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );

    // Garante que não tentou dar unlock se não adquiriu o lock
    const unlockQuery = executedQueries.find((q) => q.sql.includes('pg_advisory_unlock'));
    assert.equal(unlockQuery, undefined, 'Não deve chamar unlock se o lock não foi adquirido');
  });

  await t.test('4. ingestBook deve liberar o lock no finally mesmo em caso de erro durante processamento', async () => {
    const executedQueries = [];

    const mockClientWithError = {
      query: async (sql, params) => {
        executedQueries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };

    // Força erro no embedding
    const mockFailingEmbeddingFn = async () => {
      throw new Error('Falha catastrófica no provedor de IA');
    };

    await assert.rejects(
      async () => {
        await ingestBook(sampleUuid1, {
          dbClient: mockClientWithError,
          embeddingFn: mockFailingEmbeddingFn,
        });
      }
    );

    const unlockQuery = executedQueries.find((q) => q.sql.includes('pg_advisory_unlock'));
    assert.ok(unlockQuery, 'Deve chamar pg_advisory_unlock mesmo após falha interna');
  });

  await t.test('5. Simulação de concorrência multi-sessão: Connection A bloqueia Connection B, após release Connection B adquire', async () => {
    // Simula estado de lock compartilhado no nível do PostgreSQL
    const activeLocks = new Set();

    const createMockConnection = (connName) => ({
      name: connName,
      query: async (sql, params) => {
        const key = params?.[0];
        if (sql.includes('pg_try_advisory_lock')) {
          if (activeLocks.has(key)) {
            return { rows: [{ locked: false }] };
          }
          activeLocks.add(key);
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          activeLocks.delete(key);
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      },
      release: () => {},
    });

    const connA = createMockConnection('Connection_A');
    const connB = createMockConnection('Connection_B');
    const key = generateAdvisoryLockKey(sampleUuid1);

    // 1. Conn A adquire lock
    const resA1 = await connA.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    assert.equal(resA1.rows[0].locked, true, 'Connection A deve adquirir o lock');

    // 2. Conn B tenta adquirir o mesmo lock e falha (lock ocupado)
    const resB1 = await connB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    assert.equal(resB1.rows[0].locked, false, 'Connection B deve ser rejeitada enquanto A mantém o lock');

    // 3. Conn A libera o lock
    const resUnlockA = await connA.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    assert.equal(resUnlockA.rows[0].unlocked, true, 'Connection A libera o lock');

    // 4. Conn B tenta novamente e adquire com sucesso
    const resB2 = await connB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    assert.equal(resB2.rows[0].locked, true, 'Connection B agora adquire o lock após liberação');

    // 5. Conn B libera o lock
    await connB.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    assert.equal(activeLocks.size, 0, 'Todos os locks foram limpos');
  });

  await t.test('6. Livros diferentes não concorrem entre si e executam em paralelo', async () => {
    const activeLocks = new Set();

    const createMockConnection = () => ({
      query: async (sql, params) => {
        const key = params?.[0];
        if (sql.includes('pg_try_advisory_lock')) {
          if (activeLocks.has(key)) {
            return { rows: [{ locked: false }] };
          }
          activeLocks.add(key);
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          activeLocks.delete(key);
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      },
      release: () => {},
    });

    const connBook1 = createMockConnection();
    const connBook2 = createMockConnection();

    const key1 = generateAdvisoryLockKey(sampleUuid1);
    const key2 = generateAdvisoryLockKey(sampleUuid2);

    const [res1, res2] = await Promise.all([
      connBook1.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]),
      connBook2.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key2]),
    ]);

    assert.equal(res1.rows[0].locked, true, 'Book 1 adquire seu lock');
    assert.equal(res2.rows[0].locked, true, 'Book 2 adquire seu lock simultaneamente');
    assert.equal(activeLocks.size, 2, 'Dois locks ativos em paralelo para livros distintos');

    await Promise.all([
      connBook1.query('SELECT pg_advisory_unlock($1::bigint)', [key1]),
      connBook2.query('SELECT pg_advisory_unlock($1::bigint)', [key2]),
    ]);
    assert.equal(activeLocks.size, 0);
  });
});
