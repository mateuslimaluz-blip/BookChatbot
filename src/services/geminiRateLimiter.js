import { env } from '../config/env.js';

/**
 * Estimativa conservadora de tokens baseada em caracteres (~4 caracteres por token).
 *
 * @param {string} text - Texto de entrada
 * @returns {number} Quantidade estimada de tokens
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 1;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Função utilitária de sleep.
 *
 * @param {number} ms - Tempo em milissegundos
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Limitador de taxa compartilhado para chamadas de Embedding da API Google Gemini.
 * Implementa janela móvel de 60 segundos com orçamento em Tokens Por Minuto (TPM)
 * e proteção estrita contra erros 429 (RESOURCE_EXHAUSTED).
 */
export class GeminiTokenRateLimiter {
  constructor({
    tpmLimit = env.GEMINI_EMBEDDING_TPM_LIMIT || 20_000,
    windowMs = 60_000,
  } = {}) {
    this.tpmLimit = tpmLimit;
    this.windowMs = windowMs;
    // Histórico de tokens consumidos: array de { timestamp: number, tokens: number }
    this.history = [];
    // Timestamp até o qual novas chamadas devem aguardar após 429 (cooldown)
    this.cooldownUntil = 0;
    // Fila para serialização de chamadas de ingestão
    this.ingestionQueue = Promise.resolve();
  }

  /**
   * Remove registros fora da janela móvel de 60 segundos.
   *
   * @param {number} now
   */
  _purgeExpired(now) {
    const cutoff = now - this.windowMs;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      this.history.shift();
    }
  }

  /**
   * Calcula o total de tokens registrados na janela móvel atual.
   *
   * @param {number} now
   * @returns {number}
   */
  getCurrentWindowTokens(now = Date.now()) {
    this._purgeExpired(now);
    return this.history.reduce((sum, item) => sum + item.tokens, 0);
  }

  /**
   * Adquire orçamento de tokens antes de disparar a requisição de embedding.
   * Se o limite de TPM for atingido ou se houver cooldown ativo pós-429,
   * a chamada aguarda o tempo necessário.
   *
   * @param {string} text - Texto que será enviado para embedding
   * @param {object} [options]
   * @param {boolean} [options.isPriority=false] - Define prioridade (ex: consultas interativas de chat)
   * @returns {Promise<{ tokens: number }>}
   */
  async acquire(text, { isPriority = false } = {}) {
    const estimatedTokens = estimateTokens(text);

    // Se for chamada de ingestão (não-prioritária), serializa para evitar rajadas simultâneas
    if (!isPriority) {
      return new Promise((resolve, reject) => {
        this.ingestionQueue = this.ingestionQueue
          .then(async () => {
            const result = await this._waitForCapacity(estimatedTokens);
            resolve(result);
          })
          .catch((err) => {
            reject(err);
          });
      });
    }

    return this._waitForCapacity(estimatedTokens);
  }

  /**
   * Aguarda capacidade disponível na janela móvel e respeito ao cooldown.
   *
   * @private
   * @param {number} tokens
   * @returns {Promise<{ tokens: number }>}
   */
  async _waitForCapacity(tokens) {
    while (true) {
      const now = Date.now();

      // 1. Respeita cooldown ativo resultante de um 429 prévio
      if (now < this.cooldownUntil) {
        const waitMs = this.cooldownUntil - now + 100;
        await sleep(waitMs);
        continue;
      }

      this._purgeExpired(now);
      const currentTokens = this.history.reduce((sum, item) => sum + item.tokens, 0);

      // 2. Verifica se a nova chamada cabe no orçamento de TPM
      if (currentTokens + tokens <= this.tpmLimit || this.history.length === 0) {
        // Registra o consumo
        this.history.push({ timestamp: Date.now(), tokens });
        return { tokens };
      }

      // 3. Calcula quanto tempo aguardar até que o item mais antigo saia da janela móvel
      const oldest = this.history[0];
      const waitMs = Math.max(100, oldest.timestamp + this.windowMs - now + 50);
      await sleep(waitMs);
    }
  }

  /**
   * Processa e registra um erro 429 / RESOURCE_EXHAUSTED retornado pela API do Gemini.
   * Define um cooldown obrigatório de pelo menos 60 segundos (com jitter) ou baseado
   * no cabeçalho Retry-After.
   *
   * @param {Error} error - Exceção lançada pela API
   * @returns {{ isRateLimit: boolean, retryAfterMs: number, isDailyQuota: boolean }}
   */
  handleRateLimitError(error) {
    const message = error?.message || '';
    const status = error?.status || error?.statusCode;

    const is429 =
      status === 429 ||
      message.includes('429') ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('Quota exceeded') ||
      message.includes('quota metric');

    if (!is429) {
      return { isRateLimit: false, retryAfterMs: 0, isDailyQuota: false };
    }

    // Identifica se é esgotamento de cota diária permanente vs limite de tokens por minuto (TPM)
    const isDailyQuota =
      message.toLowerCase().includes('per day') ||
      message.toLowerCase().includes('daily quota') ||
      message.toLowerCase().includes('free_tier_queries_per_day');

    let retryAfterMs = 60_000;

    // Tenta extrair Retry-After em segundos ou milissegundos se presente na mensagem
    const retryMatch = message.match(/retry(?:-after)?[:\s]+(\d+)/i);
    if (retryMatch) {
      const parsed = parseInt(retryMatch[1], 10);
      if (parsed > 0) {
        // Se for menor que 1000, presume segundos
        retryAfterMs = parsed < 1000 ? parsed * 1000 : parsed;
      }
    } else {
      // Cooldown de 60 segundos com jitter aleatório de 1 a 5 segundos
      retryAfterMs = 60_000 + Math.floor(Math.random() * 5000);
    }

    // Se for cota diária, o cooldown deve ser de pelo menos várias horas
    if (isDailyQuota) {
      retryAfterMs = Math.max(retryAfterMs, 3_600_000); // 1 hora no mínimo
    }

    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);

    return {
      isRateLimit: true,
      retryAfterMs,
      isDailyQuota,
    };
  }
}

/**
 * Instância singleton compartilhada por toda a aplicação.
 */
export const embeddingRateLimiter = new GeminiTokenRateLimiter({
  tpmLimit: env.GEMINI_EMBEDDING_TPM_LIMIT,
});
