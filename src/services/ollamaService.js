import { env } from '../config/env.js';
import { RAG_SYSTEM_INSTRUCTION, parseRagModelResponse } from './aiService.js';

/**
 * Padrão que identifica respostas que DECLARAM explicitamente que a informação
 * não foi encontrada nos trechos. Usado para decidir se uma nova tentativa
 * limitada faz sentido (declarações de "não encontrou" nunca são repetidas).
 */
const NOT_FOUND_ANSWER_RE =
  /não encontrei (essa |esta )?informação|não foi possível encontrar|informação suficiente não encontrada|não encontrei menção|não consta nas obras disponíveis|não há menção/i;

/**
 * Limite de tentativas na chamada ao Ollama: 1 tentativa inicial + no máximo
 * 1 nova tentativa limitada (sem loops).
 */
const MAX_OLLAMA_ATTEMPTS = 2;

/**
 * Pausa curta antes da nova tentativa limitada (evita atrasos longos).
 */
const OLLAMA_RETRY_DELAY_MS = 250;

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

Responda à <USER_QUERY> com base APENAS nos trechos de <CONTEXT>. Cada trecho tem um número de fonte entre colchetes ([1], [2]...).

DIRETRIZES OBRIGATÓRIAS:
1. Responda em JSON: {"answer": "...", "citations": [...]}
2. Estrutura da resposta: Escreva em português simples, objetivo e bem estruturado, em 3 a 5 frases (especialmente para resumos, resenhas e visões gerais).
3. DISTINÇÃO ENTRE ESCRITOR REAL E NARRADOR/PERSONAGEM:
   - Separe claramente o escritor real da obra do narrador e dos personagens fictícios.
   - Em "Memórias Póstumas de Brás Cubas", Machado de Assis é o escritor real e Brás Cubas é o narrador-personagem ("defunto autor").
   - Quem morre em agosto de 1869 aos 64 anos dentro da narrativa é o personagem Brás Cubas, NUNCA o autor Machado de Assis.
   - Não transforme a vida do personagem em biografia de Machado nem diga que o livro foi publicado postumamente na vida real sem fonte expressa.
4. No campo "answer", marque cada afirmação com o número da fonte entre colchetes, ex: "O narrador Brás Cubas relata sua própria morte em 1869 [1]."
5. No campo "citations", liste apenas os números de fonte que realmente contêm as informações usadas, ex: [1, 2].
6. NUNCA use conhecimento prévio ou externo para complementar ou definir termos que apenas aparecem de passagem.
7. Se os trechos não sustentarem uma resenha ou a resposta pedida, retorne exatamente:
   {"answer": "Não encontrei informação suficiente nas obras disponíveis para responder a essa pergunta.", "citations": []}.`;

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

  // Executa UMA tentativa de chamada ao Ollama. Lança nos erros de
  // rede/timeout/status/corpo, exatamente como antes.
  const attemptRequest = async () => {
    const startedAt = Date.now();
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
    return {
      parsed: parseRagModelResponse(rawContent),
      elapsedMs: Date.now() - startedAt,
    };
  };

  let best = await attemptRequest();

  // Nova tentativa LIMITADA (no máximo MAX_OLLAMA_ATTEMPTS - 1 repetição),
  // acionada apenas quando o modelo local pequeno (llama3.2) devolve uma
  // resposta sem "citations" e sem declarar que não encontrou a informação
  // (saída degenerada, frequentemente eco da própria pergunta). Nunca repete
  // erros de rede/timeout nem respostas que já declaram "não encontrou".
  // Só repete quando a tentativa anterior foi rápida o suficiente para caber
  // no orçamento de timeout, evitando loops e atrasos longos.
  for (let attempt = 1; attempt < MAX_OLLAMA_ATTEMPTS; attempt++) {
    const hasCitations =
      Array.isArray(best.parsed.citations) && best.parsed.citations.length > 0;
    const declaresNotFound = NOT_FOUND_ANSWER_RE.test(best.parsed.answer || '');

    if (hasCitations || declaresNotFound) {
      break;
    }

    if (best.elapsedMs >= Math.floor(timeoutMs / 2)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, OLLAMA_RETRY_DELAY_MS));

    try {
      best = await attemptRequest();
    } catch {
      // Nova tentativa falhou (ex.: timeout): mantém a melhor resposta já
      // obtida para que a validação de fontes do RAG decida (fallback seguro),
      // sem mascarar o comportamento anterior com uma exceção nova.
      break;
    }
  }

  return best.parsed;
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
