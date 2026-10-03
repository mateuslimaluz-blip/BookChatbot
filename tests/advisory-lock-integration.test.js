import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateAdvisoryLockKey } from '../src/services/ingestionService.js';

const { Pool, Client } = pg;

test('PostgreSQL Advisory Lock Live Integration (Real DB Connections)', async (t) => {
  const dbUrl = process.env.RAG_BENCHMARK_DATABASE_URL || process.env.TEST_DATABASE_URL;

  if (!dbUrl) {
    t.skip(
      'Teste de integração ao vivo pulado: RAG_BENCHMARK_DATABASE_URL ou TEST_DATABASE_URL não configurada.'
    );
    return;
  }

  let pool;
  try {
    pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 3000,
    });
    // Test connectivity
    const probe = await pool.connect();
    probe.release();
  } catch (err) {
    t.skip(`Falha na conexão com o banco de teste: ${err.message}`);
    return;
  }

  const bookId1 = '00000000-0000-4000-8000-000000000001';
  const bookId2 = '00000000-0000-4000-8000-000000000002';
  const key1 = generateAdvisoryLockKey(bookId1);
  const key2 = generateAdvisoryLockKey(bookId2);

  await t.test('1. Concorrência Real: Conexão A bloqueia Conexão B; após unlock de A, Conexão B obtém lock', async () => {
    const connA = await pool.connect();
    const connB = await pool.connect();

    try {
      // 1. Conexão A adquire o lock
      const resA1 = await connA.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      assert.equal(resA1.rows[0].locked, true, 'Conexão A deve adquirir o lock com sucesso');

      // 2. Conexão B tenta adquirir o mesmo lock e recebe false
      const resB1 = await connB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      assert.equal(resB1.rows[0].locked, false, 'Conexão B deve ser rejeitada enquanto A retém o lock');

      // 3. Conexão A libera o lock
      const resUnlockA = await connA.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key1]);
      assert.equal(resUnlockA.rows[0].unlocked, true, 'Conexão A deve liberar o lock');

      // 4. Conexão B tenta novamente e agora obtém true
      const resB2 = await connB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      assert.equal(resB2.rows[0].locked, true, 'Conexão B deve adquirir o lock após Conexão A liberar');

      // 5. Conexão B libera o lock
      const resUnlockB = await connB.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key1]);
      assert.equal(resUnlockB.rows[0].unlocked, true, 'Conexão B deve liberar o lock');
    } finally {
      connA.release();
      connB.release();
    }
  });

  await t.test('2. Livros Diferentes: Conexão A e Conexão B adquirem locks simultâneos para livros distintos', async () => {
    const connA = await pool.connect();
    const connB = await pool.connect();

    try {
      const [resA, resB] = await Promise.all([
        connA.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]),
        connB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key2]),
      ]);

      assert.equal(resA.rows[0].locked, true, 'Conexão A obtém lock para Livro 1');
      assert.equal(resB.rows[0].locked, true, 'Conexão B obtém lock para Livro 2 simultaneamente');

      await Promise.all([
        connA.query('SELECT pg_advisory_unlock($1::bigint)', [key1]),
        connB.query('SELECT pg_advisory_unlock($1::bigint)', [key2]),
      ]);
    } finally {
      connA.release();
      connB.release();
    }
  });

  await t.test('3. Liberação Garantida em Falha: Lock liberado no finally após exception', async () => {
    const conn = await pool.connect();
    let hasLock = false;

    try {
      const lockRes = await conn.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      hasLock = Boolean(lockRes.rows[0].locked);
      assert.equal(hasLock, true);

      // Simula erro durante o processamento
      throw new Error('Falha simulada durante processamento');
    } catch {
      // Ignora erro simulado
    } finally {
      if (hasLock) {
        await conn.query('SELECT pg_advisory_unlock($1::bigint)', [key1]);
      }
      conn.release();
    }

    // Verifica que uma nova conexão consegue adquirir o lock imediatamente
    const newConn = await pool.connect();
    try {
      const verifyRes = await newConn.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      assert.equal(verifyRes.rows[0].locked, true, 'Novo client adquire lock após liberação no finally');
      await newConn.query('SELECT pg_advisory_unlock($1::bigint)', [key1]);
    } finally {
      newConn.release();
    }
  });

  await t.test('4. Abandono de Sessão: Conexão A encerrada sem unlock explícito libera o lock no PostgreSQL', async () => {
    // Cria cliente direto não gerenciado pelo pool para forçar disconnect abrupto
    const directClient = new Client({ connectionString: dbUrl });
    await directClient.connect();

    // Direct client adquire o lock
    const resA = await directClient.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
    assert.equal(resA.rows[0].locked, true);

    // Encerra a conexão diretamente sem unlock
    await directClient.end();

    // Conexão do pool tenta adquirir o mesmo lock
    const connVerify = await pool.connect();
    try {
      const resAfterDrop = await connVerify.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key1]);
      assert.equal(
        resAfterDrop.rows[0].locked,
        true,
        'PostgreSQL deve liberar session advisory lock automaticamente após encerramento da conexão'
      );
      await connVerify.query('SELECT pg_advisory_unlock($1::bigint)', [key1]);
    } finally {
      connVerify.release();
    }
  });

  await pool.end();
});
