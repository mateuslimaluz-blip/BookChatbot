import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../config/db.js';
import { env } from '../config/env.js';
import { books, bookEmbeddings, EMBEDDING_DIMENSION } from '../db/schema.js';
import { generateChunkEmbedding } from './aiService.js';

/**
 * Parâmetros de Chunking e Tokenização aproximada.
 * Em média, 1 token corresponde a ~4 caracteres em textos em português/inglês.
 */
export const CHARS_PER_TOKEN = 4;
export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 100;
export const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN; // 3200 caracteres
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN; // 400 caracteres
export const MIN_CHUNK_CHARS = 50;
export const MAX_CONTENT_CHARS = 5_000_000; // Limite de ~5MB de texto para controle de custo e abuso

/**
 * Concorrência padrão para chamadas à API de Embeddings do Gemini.
 */
export const EMBEDDING_CONCURRENCY = env.EMBEDDING_CONCURRENCY;

/**
 * Diretório padrão seguro para leitura de arquivos de livros.
 */
export const DEFAULT_STORAGE_DIR = env.BOOKS_STORAGE_DIR;

/**
 * Converte deterministamente um UUID em uma chave BigInt de 64 bits com sinal
 * para uso com PostgreSQL Advisory Locks (`pg_try_advisory_lock`).
 *
 * @param {string} uuid - UUID do livro
 * @returns {string} String numérica representando o BigInt com sinal de 64 bits
 */
export function generateAdvisoryLockKey(uuid) {
  if (!uuid || typeof uuid !== 'string' || uuid.trim() === '') {
    throw new Error('UUID inválido para geração de advisory lock.');
  }

  const cleanUuid = uuid.replace(/-/g, '').toLowerCase();
  const hash = crypto.createHash('sha256').update(cleanUuid).digest();
  const rawBigInt = hash.readBigInt64BE(0);
  return rawBigInt.toString();
}

/**
 * Resolve e valida caminhos de arquivos de livros para impedir ataques de Path Traversal.
 *
 * @param {string} filePath - Caminho relativo ou absoluto fornecido
 * @param {string} [baseDir=DEFAULT_STORAGE_DIR] - Diretório raiz permitido
 * @returns {string} Caminho seguro resolvido
 */
export function resolveSafeBookPath(filePath, baseDir = DEFAULT_STORAGE_DIR) {
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Caminho de arquivo de livro inválido.');
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedBase, filePath);

  const isAllowed =
    resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;

  if (!isAllowed) {
    throw new Error('Acesso negado: o caminho do arquivo está fora do diretório autorizado de livros.');
  }

  return resolvedTarget;
}

/**
 * Normaliza o texto de um livro mantendo sua estrutura literária,
 * pontuação, acentuação e parágrafos originais.
 *
 * @param {string} text - Texto bruto
 * @returns {string} Texto normalizado
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/\r\n/g, '\n') // Normaliza quebras de linha Windows para Unix
    .replace(/\r/g, '\n') // Normaliza quebras de linha Mac antigo
    .replace(/[ \t]+/g, ' ') // Substitui espaços horizontais e tabs múltiplos por espaço simples
    .replace(/ \n/g, '\n') // Remove espaços antes de quebras de linha
    .replace(/\n /g, '\n') // Remove espaços após quebras de linha
    .replace(/\n{3,}/g, '\n\n') // Reduz 3+ quebras de linha para no máximo 2 (preserva parágrafos)
    .trim();
}

/**
 * Divide um texto em chunks estruturados baseados em parágrafos, frases e palavras,
 * respeitando os limites de tokens alvo e aplicando overlap para preservar o contexto.
 *
 * @param {string} text - Texto já normalizado
 * @param {object} [options] - Parâmetros customizáveis
 * @param {number} [options.targetChars=CHUNK_TARGET_CHARS] - Tamanho aproximado de cada chunk
 * @param {number} [options.overlapChars=CHUNK_OVERLAP_CHARS] - Tamanho do overlap entre chunks adjacentes
 * @param {number} [options.minChars=MIN_CHUNK_CHARS] - Tamanho mínimo de um chunk
 * @returns {string[]} Lista de chunks textuais
 */
export function splitIntoChunks(
  text,
  {
    targetChars = CHUNK_TARGET_CHARS,
    overlapChars = CHUNK_OVERLAP_CHARS,
    minChars = MIN_CHUNK_CHARS,
  } = {}
) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  if (normalized.length <= targetChars) {
    return [normalized];
  }

  // 1. Divide em blocos menores (parágrafos -> frases -> palavras)
  const paragraphs = normalized.split(/\n\n+/);
  const segments = [];

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (trimmedPara.length <= targetChars) {
      segments.push(trimmedPara);
    } else {
      // Divide parágrafo grande em frases
      const sentences = trimmedPara.split(/(?<=[.!?…])\s+/);
      for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;

        if (trimmedSentence.length <= targetChars) {
          segments.push(trimmedSentence);
        } else {
          // Se uma frase for maior que o chunk alvo, divide por palavras
          const words = trimmedSentence.split(/\s+/);
          let currentWordChunk = '';
          for (const word of words) {
            if ((currentWordChunk + ' ' + word).trim().length <= targetChars) {
              currentWordChunk = (currentWordChunk + ' ' + word).trim();
            } else {
              if (currentWordChunk) segments.push(currentWordChunk);
              currentWordChunk = word;
            }
          }
          if (currentWordChunk) segments.push(currentWordChunk);
        }
      }
    }
  }

  // 2. Agrupa segmentos respeitando targetChars e overlap
  const chunks = [];
  let currentChunk = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const candidate = currentChunk ? currentChunk + '\n\n' + segment : segment;

    if (candidate.length <= targetChars) {
      currentChunk = candidate;
    } else {
      if (currentChunk.trim().length >= minChars) {
        chunks.push(currentChunk.trim());
      }

      // Calcula o overlap com o final do chunk anterior
      if (overlapChars > 0 && currentChunk) {
        const overlapSlice = currentChunk.slice(-overlapChars).trim();
        currentChunk = overlapSlice ? overlapSlice + '\n\n' + segment : segment;
      } else {
        currentChunk = segment;
      }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter((c) => c && c.trim().length > 0);
}

/**
 * Executa tarefas assíncronas com concorrência controlada.
 *
 * @template T, R
 * @param {T[]} items - Array de itens
 * @param {number} concurrency - Número máximo de execuções simultâneas
 * @param {(item: T, index: number) => Promise<R>} fn - Função de processamento
 * @returns {Promise<R[]>} Resultados na mesma ordem original dos itens
 */
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  };

  const poolSize = Math.min(concurrency, items.length);
  const workers = Array.from({ length: poolSize }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Obtém o conteúdo textual de um livro a partir do campo `content` ou `content_path`.
 *
 * @param {object} book - Registro do livro do banco de dados
 * @returns {Promise<{ rawContent: string, source: 'content' | 'content_path' }>}
 */
export async function extractBookContent(book) {
  if (book.content && typeof book.content === 'string' && book.content.trim().length > 0) {
    return {
      rawContent: book.content,
      source: 'content',
    };
  }

  if (book.contentPath && typeof book.contentPath === 'string' && book.contentPath.trim().length > 0) {
    const safePath = resolveSafeBookPath(book.contentPath);
    try {
      await fs.access(safePath);
    } catch {
      throw new Error(`Arquivo de origem do livro não encontrado no caminho autorizado.`);
    }

    const fileBuffer = await fs.readFile(safePath, 'utf8');
    if (!fileBuffer || fileBuffer.trim().length === 0) {
      throw new Error('O arquivo de origem do livro está vazio.');
    }

    return {
      rawContent: fileBuffer,
      source: 'content_path',
    };
  }

  throw new Error('O livro não possui conteúdo válido nem caminho de arquivo associado.');
}

/**
 * Orquestra o pipeline de ingestão RAG utilizando PostgreSQL Advisory Lock por bookId:
 * 1. Adquire advisory lock de sessão dedicado para o bookId via `pg_try_advisory_lock`;
 * 2. Se o lock estiver ocupado, retorna erro 409 INGESTION_IN_PROGRESS sem desperdiçar recursos;
 * 3. Extrai e valida o conteúdo textual do livro;
 * 4. Normaliza e divide em chunks estruturados;
 * 5. Gera embeddings via Gemini com concorrência limitada;
 * 6. Persiste de forma atômica e idempotente no PostgreSQL via transação;
 * 7. Libera o advisory lock e a conexão de forma garantida no bloco `finally`.
 *
 * @param {string} bookId - ID (UUID) do livro a ser ingerido
 * @param {object} [options] - Opções de execução
 * @param {number} [options.concurrency=EMBEDDING_CONCURRENCY] - Limite de concorrência na API
 * @param {function} [options.embeddingFn] - Função de embedding injetável para testes
 * @param {object} [options.dbClient] - Cliente PostgreSQL injetável para testes
 * @returns {Promise<{ bookId: string, chunksCount: number, status: string }>}
 */
export async function ingestBook(
  bookId,
  {
    concurrency = EMBEDDING_CONCURRENCY,
    embeddingFn = generateChunkEmbedding,
    dbClient = null,
  } = {}
) {
  if (!bookId) {
    throw new Error('O ID do livro é obrigatório para a ingestão.');
  }

  const lockKey = generateAdvisoryLockKey(bookId);
  const client = dbClient || (await pool.connect());
  let hasLock = false;

  try {
    // 1. Tenta adquirir o PostgreSQL Advisory Lock para o bookId específico
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [lockKey]
    );

    hasLock = Boolean(lockResult.rows?.[0]?.locked);

    if (!hasLock) {
      const error = new Error('A ingestão deste livro já está em andamento.');
      error.code = 'INGESTION_IN_PROGRESS';
      error.statusCode = 409;
      throw error;
    }

    // 2. Busca o livro no banco de dados
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) {
      throw new Error(`Livro com ID ${bookId} não encontrado.`);
    }

    // 3. Extrai e valida o conteúdo do livro
    const { rawContent, source } = await extractBookContent(book);

    if (rawContent.length > MAX_CONTENT_CHARS) {
      throw new Error(
        `Conteúdo do livro excede o limite máximo permitido de ${MAX_CONTENT_CHARS} caracteres.`
      );
    }

    // 4. Normalização e Chunking
    const chunks = splitIntoChunks(rawContent);
    if (!chunks || chunks.length === 0) {
      throw new Error('Não foi possível gerar chunks textuais válidos a partir do conteúdo do livro.');
    }

    // 5. Geração de embeddings com concorrência limitada
    const chunkEmbeddings = await mapConcurrent(chunks, concurrency, async (chunkText, index) => {
      const embedding = await embeddingFn(book.title, chunkText);

      if (!embedding || !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Embedding gerado para o chunk ${index} é inválido ou não possui ${EMBEDDING_DIMENSION} dimensões.`
        );
      }

      return {
        bookId: book.id,
        chunkIndex: index,
        content: chunkText,
        embedding,
        metadata: {
          source,
          chunk_index: index,
          char_count: chunkText.length,
          estimated_tokens: Math.ceil(chunkText.length / CHARS_PER_TOKEN),
          title: book.title,
        },
      };
    });

    // 6. Persistência atômica e idempotente no PostgreSQL via Transação
    await db.transaction(async (tx) => {
      // Remove os embeddings anteriores do livro antes de inserir os novos
      await tx.delete(bookEmbeddings).where(eq(bookEmbeddings.bookId, book.id));

      // Insere todos os novos chunks com seus vetores
      if (chunkEmbeddings.length > 0) {
        await tx.insert(bookEmbeddings).values(chunkEmbeddings);
      }
    });

    return {
      bookId: book.id,
      chunksCount: chunkEmbeddings.length,
      status: 'completed',
    };
  } finally {
    // 7. Liberação garantida do PostgreSQL Advisory Lock e retorno da conexão ao pool
    if (hasLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } catch (unlockErr) {
        console.error('[Advisory Lock] Falha ao liberar lock:', unlockErr.message);
      }
    }
    if (!dbClient) {
      client.release();
    }
  }
}
