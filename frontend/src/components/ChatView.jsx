import React, { useState, useEffect, useRef } from 'react';
import { sendChatMessage, listBooks } from '../api.js';

/**
 * Interface do Chatbot RAG: seleção de contexto (Acervo Geral ou Livro Específico),
 * histórico de mensagens interativas e exibição de citações com fontes verificadas.
 *
 * @param {object} props
 * @param {string|null} props.initialBookId - ID do livro pré-selecionado ao vir da Biblioteca
 * @param {function} props.onGoToLibrary - Permite navegar de volta à Biblioteca
 */
export function ChatView({ initialBookId = null, onGoToLibrary }) {
  const [selectedBookId, setSelectedBookId] = useState(initialBookId || '');
  const [availableBooks, setAvailableBooks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  const messagesEndRef = useRef(null);

  // Carrega a lista de livros que possuem embeddings para popular o seletor de contexto
  useEffect(() => {
    async function loadBooksForSelector() {
      try {
        const data = await listBooks({ page: 1, limit: 100 });
        setAvailableBooks(data.books || []);
      } catch (err) {
        console.warn('Falha ao carregar lista de livros para o seletor de chat:', err.message);
      }
    }
    loadBooksForSelector();
  }, []);

  // Sincroniza se o initialBookId mudar
  useEffect(() => {
    if (initialBookId) {
      setSelectedBookId(initialBookId);
    }
  }, [initialBookId]);

  // Rolagem automática para a mensagem mais recente
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    const query = inputText.trim();

    if (!query || isLoading) return;

    setErrorMessage(null);

    // Mensagem enviada pelo usuário
    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    try {
      const response = await sendChatMessage({
        query,
        bookId: selectedBookId || null,
      });

      // Só adiciona a mensagem do assistente se houver resposta válida
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
    } catch (err) {
      // Exibe a mensagem de erro da API sem inserir uma mensagem quebrada no array do chat
      setErrorMessage(
        err.message || 'Ocorreu um erro ao obter a resposta do chatbot. Tente novamente.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const selectedBook = availableBooks.find((b) => b.id === selectedBookId);

  return (
    <div className="chat-container" role="region" aria-label="Painel de Chat RAG">
      {/* Cabeçalho de Contexto */}
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label htmlFor="context-select" style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--text-secondary)' }}>
            Contexto da Conversa:
          </label>
          <select
            id="context-select"
            className="chat-context-select"
            value={selectedBookId}
            onChange={(e) => setSelectedBookId(e.target.value)}
            disabled={isLoading}
          >
            <option value="">🌐 Acervo Geral (Todos os livros ingeridos)</option>
            {availableBooks.map((b) => (
              <option key={b.id} value={b.id} disabled={!b.hasEmbeddings}>
                {b.title} {b.author ? `— ${b.author}` : ''} {!b.hasEmbeddings ? '(Pendente Ingestão)' : ''}
              </option>
            ))}
          </select>
        </div>

        {selectedBook && !selectedBook.hasEmbeddings && (
          <div style={{ fontSize: '0.8125rem', color: 'var(--danger)', fontWeight: '500' }}>
            ⚠️ Este livro ainda não possui embeddings. As respostas utilizarão o acervo geral até a conclusão da ingestão.
          </div>
        )}
      </div>

      {/* Área de Mensagens */}
      <div className="chat-messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="state-box" style={{ margin: 'auto', border: 'none', background: 'transparent' }}>
            <div className="state-icon" aria-hidden="true">💡</div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: '700', marginBottom: '0.5rem' }}>
              Faça uma pergunta sobre as obras
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', maxWidth: '420px', margin: '0 auto' }}>
              {selectedBook
                ? `O chatbot responderá fundamentado nos trechos e capítulos do livro "${selectedBook.title}".`
                : 'O chatbot buscará semanticamente nos embeddings de todo o acervo e citará as fontes encontradas.'}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}
            >
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text || ''}</div>

              {/* Citações e Fontes verificadas retornadas pelo RAG */}
              {msg.role === 'assistant' && Array.isArray(msg.sources) && msg.sources.length > 0 && (
                <div className="chat-sources">
                  <div className="chat-sources-title">
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
                    const hasSimilarity = typeof src.similarity === 'number';
                    const contentText = typeof src.content === 'string' ? src.content.trim() : '';

                    return (
                      <div key={src.sourceId || index} className="source-item">
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontWeight: '600',
                            marginBottom: contentText ? '0.25rem' : '0',
                          }}
                        >
                          <span>
                            📖 {title}{author}{chunkLabel}
                          </span>
                          {hasSimilarity && (
                            <span style={{ color: 'var(--primary)', fontSize: '0.75rem' }}>
                              Similaridade: {(src.similarity * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                        {contentText ? (
                          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '0.75rem' }}>
                            "{contentText.length > 180 ? `${contentText.substring(0, 180)}...` : contentText}"
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              <div
                style={{
                  fontSize: '0.6875rem',
                  color: msg.role === 'user' ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)',
                  marginTop: '0.375rem',
                  textAlign: 'right',
                }}
              >
                {msg.timestamp}
              </div>
            </div>
          ))
        )}

        {isLoading && (
          <div className="chat-bubble chat-bubble-assistant" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="spinner spinner-dark"></span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              Consultando vetores no pgvector e formulando resposta fundamentada...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {errorMessage && (
        <div style={{ padding: '0.5rem 1.25rem' }}>
          <div className="alert alert-danger" style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span aria-hidden="true">⚠️</span>
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setErrorMessage(null)}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {/* Barra de Entrada de Pergunta */}
      <form className="chat-input-bar" onSubmit={handleSendMessage}>
        <input
          type="text"
          className="chat-input"
          placeholder={
            selectedBook
              ? `Pergunte algo sobre "${selectedBook.title}"...`
              : 'Pergunte algo sobre os livros do acervo...'
          }
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={isLoading}
          aria-label="Pergunta para o chatbot"
        />

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isLoading || !inputText.trim()}
          title="Enviar pergunta"
        >
          {isLoading ? (
            <span className="spinner"></span>
          ) : (
            <>
              <span>Enviar</span>
              <span aria-hidden="true">➤</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
