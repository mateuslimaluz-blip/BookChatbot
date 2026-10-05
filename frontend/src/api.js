/**
 * Cliente de API centralizado para o BookChatbot.
 * Lê a URL base a partir da variável de ambiente VITE_API_BASE_URL (default: http://localhost:3000).
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Função utilitária para tratamento padronizado de respostas HTTP e extração de erros.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function handleResponse(response) {
  let data = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorMessage =
      data?.error?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      data?.message ||
      `Falha na requisição (HTTP ${response.status}: ${response.statusText})`;

    const error = new Error(errorMessage);
    error.status = response.status;
    error.code = data?.code || data?.error?.code;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Lista os livros cadastrados com paginação, indicador de embeddings e status da última ingestão.
 *
 * @param {object} [options]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @returns {Promise<{ success: boolean, books: Array, pagination: object }>}
 */
export async function listBooks({ page = 1, limit = 20 } = {}) {
  const url = `${BASE_URL}/books?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  return handleResponse(response);
}

/**
 * Cadastra um novo livro enviando título, autor e o arquivo TXT via multipart/form-data.
 * O navegador gera automaticamente o header Content-Type com o boundary adequado.
 *
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.author
 * @param {File} params.file
 * @returns {Promise<{ success: boolean, book: object, message: string }>}
 */
export async function createBook({ title, author, file }) {
  const formData = new FormData();
  formData.append('title', title.trim());
  formData.append('author', author.trim());
  formData.append('file', file);

  // NOTA: Não definimos Content-Type explicitamente para permitir que o navegador gere o boundary correto
  const response = await fetch(`${BASE_URL}/books`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse(response);
}

/**
 * Enfileira a ingestão RAG de um livro previamente cadastrado.
 *
 * @param {string} bookId - UUID do livro
 * @returns {Promise<{ success: boolean, jobId: string, bookId: string, status: string, message: string }>}
 */
export async function ingestBook(bookId) {
  const response = await fetch(`${BASE_URL}/books/${encodeURIComponent(bookId)}/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({}),
  });
  return handleResponse(response);
}

/**
 * Consulta o status consolidado de um livro específico (dados, embeddings e último job).
 * Utilizado como fonte principal de polling e verificação de progresso da ingestão.
 *
 * @param {string} bookId - UUID do livro
 * @returns {Promise<{ success: boolean, book: object, hasEmbeddings: boolean, latestJob: object|null }>}
 */
export async function getBookStatus(bookId) {
  const response = await fetch(`${BASE_URL}/books/${encodeURIComponent(bookId)}/status`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  return handleResponse(response);
}

/**
 * Envia uma pergunta para o chatbot RAG.
 * Pode ser direcionada a um livro específico (passando bookId) ou ao acervo geral (bookId nulo/omitido).
 *
 * @param {object} params
 * @param {string} params.query - Pergunta do usuário
 * @param {string|null} [params.bookId=null] - UUID do livro opcional
 * @returns {Promise<{ success: boolean, query: string, answer: string, sources: Array }>}
 */
export async function sendChatMessage({ query, bookId = null }) {
  const payload = {
    query: query.trim(),
  };

  if (bookId && typeof bookId === 'string' && bookId.trim() !== '') {
    payload.bookId = bookId.trim();
  }

  const response = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}

/**
 * Verifica a disponibilidade do backend (Liveness / Readiness Probe).
 *
 * @returns {Promise<boolean>}
 */
export async function checkBackendHealth() {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
