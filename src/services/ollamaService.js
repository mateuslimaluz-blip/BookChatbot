import { env } from '../config/env.js';
import { RAG_SYSTEM_INSTRUCTION, parseRagModelResponse } from './aiService.js';

/**
 * Invoca o modelo local do Ollama para gerar a resposta RAG baseada no contexto fornecido.
 * Utilizado quando AI_CHAT_PROVIDER=ollama.
 *
 * @param {object} params
 * @param {string} params.query - Pergunta do usuário
 * @param {string} params.context - Contexto delimitado dos trechos recuperados
 * @param {object} [params.options] - Opções de execução
 * @param {string} [params.options.model] - Modelo Ollama a utilizar (override)
 * @param {string} [params.options.baseUrl] - URL base do Ollama (override)
 * @param {number} [params.options.timeoutMs] - Timeout da requisição em ms
 * @returns {Promise<{ answer: string, citations: number[] }>}
 */
export async function generateOllamaRagResponse({ query, context, options = {} }) {
  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('A pergunta do usuário não pode ser vazia.');
  }

  if (!context || typeof context !== 'string' || context.trim() === '') {
    throw new Error('O contexto para geração RAG não pode ser vazio.');
  }

  const baseUrl = (options.baseUrl || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const modelName = options.model || env.OLLAMA_CHAT_MODEL || 'llama3.2';
  const timeoutMs = options.timeoutMs ?? (env.OLLAMA_TIMEOUT_MS || 60_000);

  const prompt = `<CONTEXT>
${context.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Com base estritamente no <CONTEXT> acima, responda à <USER_QUERY> em formato JSON com as seguintes chaves:
- "answer": string com a resposta fundamentada exclusivamente nos trechos de <CONTEXT>. Se os trechos não sustentarem a resposta, afirme claramente que não encontrou essa informação nas obras disponíveis.
- "citations": array de inteiros com os números de identificação das fontes utilizadas (ex: [1, 2]), ou array vazio [] se a informação não foi encontrada nos trechos.`;

  const requestBody = {
    model: modelName,
    messages: [
      {
        role: 'system',
        content: RAG_SYSTEM_INSTRUCTION,
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    format: 'json',
    stream: false,
    options: {
      temperature: 0.2,
    },
  };

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (fetchError) {
    clearTimeout(timeoutTimer);

    if (fetchError.name === 'AbortError') {
      const err = new Error(
        `Tempo limite excedido (${timeoutMs}ms) aguardando resposta do modelo local Ollama '${modelName}'. O modelo pode estar sobrecarregado ou seu hardware processando lentamente.`
      );
      err.code = 'OLLAMA_TIMEOUT';
      err.statusCode = 503;
      err.isOllamaError = true;
      throw err;
    }

    const err = new Error(
      `O serviço Ollama está desligado ou inacessível em ${baseUrl}. Inicie o servidor Ollama (ex: execute 'ollama serve' ou inicie o aplicativo Ollama) e certifique-se de que a porta está acessível.`
    );
    err.code = 'OLLAMA_UNAVAILABLE';
    err.statusCode = 503;
    err.isOllamaError = true;
    err.originalError = fetchError;
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }

  // Tratamento de status de erro retornado pelo Ollama
  if (!response.ok) {
    let errorJson = null;
    try {
      errorJson = await response.json();
    } catch {
      errorJson = null;
    }

    const rawError = errorJson?.error || response.statusText || '';

    // Modelo não encontrado localmente
    if (response.status === 404 || /not found|try pulling/i.test(rawError)) {
      const err = new Error(
        `O modelo Ollama '${modelName}' não foi encontrado no servidor local (${baseUrl}). Execute 'ollama pull ${modelName}' no terminal para baixá-lo antes de usar.`
      );
      err.code = 'OLLAMA_MODEL_NOT_FOUND';
      err.statusCode = 404;
      err.isOllamaError = true;
      throw err;
    }

    const err = new Error(
      `Falha na resposta do serviço Ollama (HTTP ${response.status}): ${rawError || 'Erro desconhecido'}`
    );
    err.code = 'OLLAMA_ERROR';
    err.statusCode = response.status >= 500 ? 503 : response.status;
    err.isOllamaError = true;
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const err = new Error('Resposta inválida retornada pelo Ollama: corpo não pôde ser interpretado como JSON.');
    err.code = 'OLLAMA_INVALID_RESPONSE';
    err.statusCode = 502;
    err.isOllamaError = true;
    throw err;
  }

  const rawContent = data?.message?.content || data?.response || '';
  return parseRagModelResponse(rawContent);
}

/**
 * Verifica a conectividade com o servidor Ollama e lista os modelos instalados.
 *
 * @param {string} [baseUrl] - URL base do Ollama
 * @returns {Promise<{ isOnline: boolean, models: string[], error?: string }>}
 */
export async function checkOllamaHealth(baseUrl = env.OLLAMA_BASE_URL) {
  const url = baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(`${url}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { isOnline: false, models: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const modelNames = Array.isArray(data?.models)
      ? data.models.map((m) => m.name || m.model).filter(Boolean)
      : [];

    return { isOnline: true, models: modelNames };
  } catch (error) {
    return { isOnline: false, models: [], error: error.message };
  } finally {
    clearTimeout(timeoutId);
  }
}
