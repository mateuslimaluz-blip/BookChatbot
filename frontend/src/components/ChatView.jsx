import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { sendChatMessage } from '../api.js';

/**
 * ChatView - Interface do Chatbot RAG.
 * Implementa exatamente os estados visuais das referências:
 * - Estado inicial (Imagem 2): Título "O QUE VAMOS VER HOJE?" e pill bar centralizados na tela
 * - Ação '+' (Imagem 3): Dropdown pill "ADICIONAR LIVRO" diretamente abaixo da barra
 * - Conversação ativa: Histórico de mensagens com citações e pill bar fixada no rodapé
 */
export const ChatView = forwardRef(function ChatView(
  {
    selectedBookId = '',
    onSelectBookId,
    availableBooks = [],
    onOpenAddBookModal,
    onRefreshBooks,
  },
  ref
) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [plusOpen, setPlusOpen] = useState(false);

  const [lastFailedQuery, setLastFailedQuery] = useState(null);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const plusDropdownRef = useRef(null);

  // Rolagem suave para a mensagem mais recente
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Fecha o dropdown do '+' ao clicar fora
  useEffect(() => {
    function handleGlobalClick(e) {
      if (
        plusOpen &&
        plusDropdownRef.current &&
        !plusDropdownRef.current.contains(e.target)
      ) {
        setPlusOpen(false);
      }
    }
    document.addEventListener('mousedown', handleGlobalClick);
    return () => document.removeEventListener('mousedown', handleGlobalClick);
  }, [plusOpen]);

  // Expõe métodos imperativos para o componente pai
  useImperativeHandle(
    ref,
    () => ({
      resetChat: () => {
        setMessages([]);
        setErrorMessage(null);
        setLastFailedQuery(null);
        setInputText('');
      },
      focusInput: () => {
        inputRef.current?.focus();
      },
    }),
    []
  );

  /**
   * Executa o envio da pergunta para o endpoint POST /chat.
   * Se addUserMessage for false, não duplica a bolha do usuário no histórico (modo retry).
   */
  const executeSend = useCallback(
    async (query, addUserMessage = true) => {
      if (!query || isLoading) return;

      setErrorMessage(null);
      setPlusOpen(false);

      if (addUserMessage) {
        const userMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          text: query,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        };
        setMessages((prev) => [...prev, userMessage]);
        setInputText('');
      }

      setIsLoading(true);

      try {
        const response = await sendChatMessage({
          query,
          bookId: selectedBookId || null,
        });

        const answerText = response?.answer || 'Não foi possível obter resposta para esta consulta.';
        const sourcesList = Array.isArray(response?.sources) ? response.sources : [];

        const assistantMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: answerText,
          sources: sourcesList,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setLastFailedQuery(null);
      } catch (err) {
        let friendlyMessage = err.message || 'Ocorreu um erro ao obter a resposta do chatbot. Tente novamente.';

        // Erro 429: limite de taxa / esgotamento de cota
        if (
          err.status === 429 ||
          err.code === 'RATE_LIMIT_EXCEEDED' ||
          /429|cota|limite de requisições|RESOURCE_EXHAUSTED/i.test(friendlyMessage)
        ) {
          friendlyMessage =
            'O modelo de IA está temporariamente limitado por cota ou taxa de requisições. Aguarde alguns instantes e clique em "Tentar novamente".';
        }
        // Erro 503: serviço ocupado / indisponibilidade temporária
        else if (
          err.status === 503 ||
          err.code === 'SERVICE_UNAVAILABLE' ||
          /503|sobrecarregado|ocupado|UNAVAILABLE|Timeout/i.test(friendlyMessage)
        ) {
          friendlyMessage =
            'O modelo de inteligência artificial está temporariamente ocupado ou sobrecarregado. Clique em "Tentar novamente" em instantes.';
        }

        setErrorMessage(friendlyMessage);
        setLastFailedQuery(query);
      } finally {
        setIsLoading(false);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    },
    [isLoading, selectedBookId]
  );

  const handleSendMessage = (e) => {
    e?.preventDefault();
    const query = inputText.trim();
    if (!query || isLoading) return;
    executeSend(query, true);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const selectedBook = availableBooks.find((b) => b.id === selectedBookId);
  const hasMessages = messages.length > 0 || isLoading;

  return (
    <div className={`chat-view ${hasMessages ? 'chat-view--active' : 'chat-view--empty'}`}>
      {/* SELETOR DE CONTEXTO (Exibido no topo quando há mensagens ativas) */}
      {hasMessages && (
        <div className="chat-top-context">
          <div className="context-indicator">
            <span className="context-label">Contexto:</span>
            <select
              className="context-select"
              value={selectedBookId}
              onChange={(e) => onSelectBookId?.(e.target.value)}
              disabled={isLoading}
              aria-label="Selecionar livro de contexto"
            >
              <option value="">🌐 Acervo Geral (Todos os livros)</option>
              {availableBooks.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.hasEmbeddings}>
                  {b.title} {b.author ? `— ${b.author}` : ''} {!b.hasEmbeddings ? '(Sem embeddings)' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn-clear-chat"
            onClick={() => {
              setMessages([]);
              setErrorMessage(null);
            }}
            title="Limpar conversa atual"
          >
            Limpar conversa
          </button>
        </div>
      )}

      {/* ÁREA DE MENSAGENS OU ESTADO INICIAL */}
      <div className="chat-scroll-area">
        {!hasMessages ? (
          /* ESTADO INICIAL (IMAGEM 2 & IMAGEM 3): Título + Input Pill centralizados */
          <div className="chat-hero">
            <h1 className="chat-hero-title">O QUE VAMOS VER HOJE?</h1>

            <div className="pill-container" ref={plusDropdownRef}>
              <form className="pill-bar" onSubmit={handleSendMessage}>
                <button
                  type="button"
                  className={`pill-btn-plus ${plusOpen ? 'pill-btn-plus--active' : ''}`}
                  onClick={() => setPlusOpen((v) => !v)}
                  title="Ações"
                  aria-label="Ações de livro"
                  aria-expanded={plusOpen}
                >
                  <PlusCircleIcon />
                </button>

                <input
                  ref={inputRef}
                  type="text"
                  className="pill-text-input"
                  placeholder="QUAL O LIVRO DE HOJE?"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isLoading}
                  autoFocus
                  aria-label="Pergunta sobre o livro"
                />

                <button
                  type="submit"
                  className="pill-btn-send"
                  disabled={isLoading || !inputText.trim()}
                  title="Enviar pergunta"
                  aria-label="Enviar"
                >
                  {isLoading ? <span className="spinner-pill" /> : <PlayNextIcon />}
                </button>
              </form>

              {/* DROPDOWN "+" (IMAGEM 3): "📎 ADICIONAR LIVRO" */}
              {plusOpen && (
                <div className="plus-action-dropdown">
                  <button
                    type="button"
                    className="plus-action-btn"
                    onClick={() => {
                      setPlusOpen(false);
                      onOpenAddBookModal?.();
                    }}
                  >
                    <PaperclipIcon />
                    <span>ADICIONAR LIVRO</span>
                  </button>
                </div>
              )}
            </div>

            {selectedBook && (
              <div className="hero-context-note">
                Contexto ativo: <strong>{selectedBook.title}</strong>{' '}
                <button
                  type="button"
                  className="hero-context-reset"
                  onClick={() => onSelectBookId?.('')}
                >
                  (usar acervo geral)
                </button>
              </div>
            )}
          </div>
        ) : (
          /* HISTÓRICO DE MENSAGENS ATIVAS */
          <div className="chat-messages-list" aria-live="polite">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-bubble ${
                  msg.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--assistant'
                }`}
              >
                <div className="chat-bubble-content">{msg.text}</div>

                {/* Fontes verificadas do RAG */}
                {msg.role === 'assistant' && Array.isArray(msg.sources) && msg.sources.length > 0 && (
                  <div className="chat-sources-block">
                    <div className="chat-sources-header">
                      Fontes Consultadas ({msg.sources.length}):
                    </div>
                    {msg.sources.map((src, index) => {
                      if (!src || typeof src !== 'object') return null;
                      const title = src.title || src.bookTitle || 'Obra do Acervo';
                      const author = src.author ? ` — ${src.author}` : '';
                      const chunkLabel =
                        typeof src.chunkIndex === 'number'
                          ? ` (Trecho #${src.chunkIndex + 1})`
                          : src.sourceId
                          ? ` (Fonte #${src.sourceId})`
                          : '';
                      const contentText = typeof src.content === 'string' ? src.content.trim() : '';

                      return (
                        <div key={src.sourceId || index} className="source-card">
                          <div className="source-card-header">
                            <span>📖 {title}{author}{chunkLabel}</span>
                            {typeof src.similarity === 'number' && (
                              <span className="source-similarity">
                                {(src.similarity * 100).toFixed(1)}% similaridade
                              </span>
                            )}
                          </div>
                          {contentText && (
                            <div className="source-card-snippet">
                              "{contentText.length > 180 ? `${contentText.substring(0, 180)}...` : contentText}"
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="chat-bubble-time">{msg.timestamp}</div>
              </div>
            ))}

            {isLoading && (
              <div className="chat-bubble chat-bubble--assistant chat-bubble--loading">
                <span className="spinner spinner-dark" />
                <span>Consultando vetores no pgvector e formulando resposta...</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* BANNER DE ERRO COM BOTÃO DE RETRY */}
      {errorMessage && (
        <div className="chat-error-bar" role="alert">
          <div className="chat-error-text">
            <span aria-hidden="true">⚠️</span>
            <span>{errorMessage}</span>
          </div>
          <div className="chat-error-actions">
            {lastFailedQuery && (
              <button
                type="button"
                className="chat-retry-btn"
                onClick={() => executeSend(lastFailedQuery, false)}
                disabled={isLoading}
                title="Tentar enviar esta pergunta novamente"
              >
                🔄 Tentar novamente
              </button>
            )}
            <button
              type="button"
              className="chat-error-close"
              onClick={() => {
                setErrorMessage(null);
                setLastFailedQuery(null);
              }}
              title="Fechar alerta"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* BARRA DE ENTRADA FIXADA (Exibida no rodapé quando há mensagens) */}
      {hasMessages && (
        <div className="chat-footer-dock">
          <div className="pill-container" ref={plusDropdownRef}>
            <form className="pill-bar" onSubmit={handleSendMessage}>
              <button
                type="button"
                className={`pill-btn-plus ${plusOpen ? 'pill-btn-plus--active' : ''}`}
                onClick={() => setPlusOpen((v) => !v)}
                title="Ações"
                aria-label="Ações de livro"
                aria-expanded={plusOpen}
              >
                <PlusCircleIcon />
              </button>

              <input
                ref={inputRef}
                type="text"
                className="pill-text-input"
                placeholder="QUAL O LIVRO DE HOJE?"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                aria-label="Pergunta sobre o livro"
              />

              <button
                type="submit"
                className="pill-btn-send"
                disabled={isLoading || !inputText.trim()}
                title="Enviar pergunta"
                aria-label="Enviar"
              >
                {isLoading ? <span className="spinner-pill" /> : <PlayNextIcon />}
              </button>
            </form>

            {/* DROPDOWN "+" */}
            {plusOpen && (
              <div className="plus-action-dropdown">
                <button
                  type="button"
                  className="plus-action-btn"
                  onClick={() => {
                    setPlusOpen(false);
                    onOpenAddBookModal?.();
                  }}
                >
                  <PaperclipIcon />
                  <span>ADICIONAR LIVRO</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

/* ── ÍCONES SVG DA INTERFACE ────────────────────────────────────────── */

function PlusCircleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function PlayNextIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="5 4 17 12 5 20 5 4" fill="none" stroke="currentColor" />
      <line x1="19" y1="4" x2="19" y2="20" stroke="currentColor" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export default ChatView;
