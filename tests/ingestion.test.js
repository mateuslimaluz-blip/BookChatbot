import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normalizeText,
  splitIntoChunks,
  resolveSafeBookPath,
  mapConcurrent,
  extractBookContent,
  CHUNK_TARGET_CHARS,
  CHUNK_OVERLAP_CHARS,
} from '../src/services/ingestionService.js';
import { formatChunkForEmbedding, EMBEDDING_DIMENSION } from '../src/services/aiService.js';

test('1. Normalização de Texto (normalizeText)', async (t) => {
  await t.test('deve normalizar quebras de linha Windows e Mac antigo para Unix', () => {
    const raw = 'Linha 1\r\nLinha 2\rLinha 3\nLinha 4';
    const normalized = normalizeText(raw);
    assert.equal(normalized, 'Linha 1\nLinha 2\nLinha 3\nLinha 4');
  });

  await t.test('deve remover espaços e tabs excessivos mantendo pontuação e acentos intactos', () => {
    const raw = '  Capítulo   I:  A   criação   de   Memórias Póstumas de Brás Cubas!   ';
    const normalized = normalizeText(raw);
    assert.equal(normalized, 'Capítulo I: A criação de Memórias Póstumas de Brás Cubas!');
  });

  await t.test('deve preservar no máximo duas quebras de linha consecutivas para parágrafos', () => {
    const raw = 'Parágrafo 1\n\n\n\n\nParágrafo 2';
    const normalized = normalizeText(raw);
    assert.equal(normalized, 'Parágrafo 1\n\nParágrafo 2');
  });

  await t.test('deve retornar string vazia para entradas nulas ou vazias', () => {
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
    assert.equal(normalizeText('   '), '');
  });
});

test('2. Chunking Estruturado e Overlap (splitIntoChunks)', async (t) => {
  await t.test('deve retornar array vazio para texto vazio', () => {
    const chunks = splitIntoChunks('');
    assert.deepEqual(chunks, []);
  });

  await t.test('deve retornar um único chunk se o texto for menor que o target', () => {
    const shortText = 'Este é um livro muito curto que cabe perfeitamente em um único chunk.';
    const chunks = splitIntoChunks(shortText, { targetChars: 500, overlapChars: 50 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], shortText);
  });

  await t.test('deve dividir textos longos em múltiplos chunks respeitando parágrafos e frases', () => {
    const p1 = 'Capítulo Primeiro. Ao verme que primeiro roeu as frias carnes de meu cadáver dedico como saudosa lembrança estas memórias póstumas.';
    const p2 = 'Algum tempo hesitei se devia abrir estas memórias pelo princípio ou pelo fim, isto é, se poria em primeiro lugar o meu nascimento ou a minha morte.';
    const p3 = 'Suposto o uso vulgar seja começar pelo nascimento, duas considerações me levaram a adotar diferente método.';
    const longText = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = splitIntoChunks(longText, {
      targetChars: 160,
      overlapChars: 30,
      minChars: 20,
    });

    assert.ok(chunks.length >= 2, `Esperado múltiplos chunks, obtido: ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.trim().length > 0, 'Nenhum chunk deve ser vazio');
    }
  });

  await t.test('deve aplicar overlap contextual entre chunks adjacentes sem entrar em loop infinito', () => {
    const text = 'Frase um detalhada. Frase dois detalhada. Frase três detalhada. Frase quatro detalhada. Frase cinco detalhada. Frase seis detalhada.';
    const chunks = splitIntoChunks(text, {
      targetChars: 60,
      overlapChars: 20,
      minChars: 10,
    });

    assert.ok(chunks.length > 1);
    // Verifica se não há loops e se o índice avança
    assert.ok(chunks.length <= 10);
    // Cada chunk não deve ser vazio
    chunks.forEach((chunk, i) => {
      assert.ok(chunk.length > 0, `Chunk ${i} não deve ser vazio`);
    });
  });
});

test('3. Segurança de Caminho e Path Traversal (resolveSafeBookPath)', async (t) => {
  const allowedDir = path.resolve('storage', 'books');

  await t.test('deve permitir arquivos dentro do diretório autorizado', () => {
    const safePath = resolveSafeBookPath('dom_casmurro.txt', allowedDir);
    assert.ok(safePath.startsWith(allowedDir));
    assert.equal(safePath, path.resolve(allowedDir, 'dom_casmurro.txt'));
  });

  await t.test('deve rejeitar tentativas de path traversal com ../', () => {
    assert.throws(
      () => resolveSafeBookPath('../../etc/passwd', allowedDir),
      /Acesso negado/
    );
  });

  await t.test('deve rejeitar caminhos absolutos fora do diretório autorizado', () => {
    const unauthorizedPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\calc.exe' : '/etc/hosts';
    assert.throws(
      () => resolveSafeBookPath(unauthorizedPath, allowedDir),
      /Acesso negado/
    );
  });

  await t.test('deve rejeitar caminhos nulos ou vazios', () => {
    assert.throws(() => resolveSafeBookPath(''), /inválido/);
    assert.throws(() => resolveSafeBookPath(null), /inválido/);
  });
});

test('4. Concorrência Limitada (mapConcurrent)', async (t) => {
  await t.test('deve processar todos os itens mantendo ordem e respeitando o limite de concorrência', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let activeWorkers = 0;
    let maxObservedWorkers = 0;

    const results = await mapConcurrent(items, 3, async (num) => {
      activeWorkers++;
      maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
      // Simula delay de API assíncrona
      await new Promise((r) => setTimeout(r, 20));
      activeWorkers--;
      return num * 10;
    });

    assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70, 80]);
    assert.ok(maxObservedWorkers <= 3, `Concorrência observada (${maxObservedWorkers}) excedeu o limite configurado (3)`);
  });
});

test('5. Formatação para Retrieval (formatChunkForEmbedding)', async (t) => {
  await t.test('deve formatar no padrão oficial: title: {title} | text: {chunk}', () => {
    const formatted = formatChunkForEmbedding('Memórias Póstumas', 'Ao verme que primeiro roeu...');
    assert.equal(formatted, 'title: Memórias Póstumas | text: Ao verme que primeiro roeu...');
  });

  await t.test('deve tratar título ou chunk vazios de forma segura', () => {
    const formatted = formatChunkForEmbedding('', 'Texto qualquer');
    assert.equal(formatted, 'title: Sem título | text: Texto qualquer');
  });
});

test('6. Obtenção do Conteúdo (extractBookContent)', async (t) => {
  await t.test('deve priorizar content direto quando válido', async () => {
    const book = {
      content: 'Conteúdo direto do livro no banco',
      contentPath: 'storage/books/outro.txt',
    };
    const result = await extractBookContent(book);
    assert.equal(result.source, 'content');
    assert.equal(result.rawContent, 'Conteúdo direto do livro no banco');
  });

  await t.test('deve lançar erro se o livro não possuir nem content nem contentPath', async () => {
    const book = {
      content: null,
      contentPath: null,
    };
    await assert.rejects(() => extractBookContent(book), /não possui conteúdo válido/);
  });
});
