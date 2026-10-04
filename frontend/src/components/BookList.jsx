import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listBooks, ingestBook, getBookStatus } from '../api.js';
import { BookCard } from './BookCard.jsx';
import { AddBookModal } from './AddBookModal.jsx';

/**
 * Visualização da Biblioteca de Livros: listagem paginada, cadastro e monitoramento de ingestão.
 *
 * @param {object} props
 * @param {function} props.onSelectBookForChat - Chamado quando o usuário clica em 'Conversar'
 */
export function BookList({ onSelectBookForChat }) {
  const [books, setBooks] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [updatingBookIds, setUpdatingBookIds] = useState(new Set());

  // Ref para controlar o timer de polling contínuo sem stale closures
  const pollingTimerRef = useRef(null);

  /**
   * Busca a lista paginada de livros da API.
   */
  const fetchBooks = useCallback(async (pageToLoad = 1, showSpinner = true) => {
    if (showSpinner) setIsLoading(true);
    setErrorMessage(null);

    try {
      const data = await listBooks({ page: pageToLoad, limit: 20 });
      setBooks(data.books || []);
      setPagination(data.pagination || { page: pageToLoad, limit: 20, total: 0, totalPages: 1 });
    } catch (err) {
      setErrorMessage(
        err.message || 'Falha ao carregar a lista de livros da API. Verifique a conectividade com o servidor.'
      );
    } finally {
      if (showSpinner) setIsLoading(false);
    }
  }, []);

  // Carga inicial
  useEffect(() => {
    fetchBooks(1, true);
  }, [fetchBooks]);

  /**
   * Atualiza o status pontual de um único livro utilizando GET /books/:id/status.
   */
  const refreshSingleBookStatus = useCallback(async (bookId) => {
    setUpdatingBookIds((prev) => new Set(prev).add(bookId));
    try {
      const result = await getBookStatus(bookId);
      if (result?.book) {
        setBooks((prevBooks) =>
          prevBooks.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  hasEmbeddings: result.hasEmbeddings,
                  latestJob: result.latestJob,
                }
              : b
          )
        );
      }
    } catch (err) {
      console.warn(`Erro ao consultar status do livro ${bookId}:`, err.message);
    } finally {
      setUpdatingBookIds((prev) => {
        const next = new Set(prev);
        next.delete(bookId);
        return next;
      });
    }
  }, []);

  /**
   * Dispara o enfileiramento manual de ingestão para um livro.
   */
  const handleStartIngest = async (bookId) => {
    try {
      await ingestBook(bookId);
      await refreshSingleBookStatus(bookId);
    } catch (err) {
      alert(`Falha ao iniciar ingestão: ${err.message}`);
    }
  };

  /**
   * Callback após cadastro bem-sucedido via modal.
   */
  const handleBookAdded = async (newBook) => {
    await fetchBooks(1, false);
    if (newBook?.id) {
      refreshSingleBookStatus(newBook.id);
    }
  };

  /**
   * Polling inteligente: se houver algum livro com job 'queued', 'running' ou 'waiting_retry',
   * consulta periodicamente o status até a finalização.
   */
  useEffect(() => {
    const hasActiveJob = books.some((b) => {
      const status = b.latestJob?.status;
      return status === 'queued' || status === 'running' || status === 'waiting_retry';
    });

    if (hasActiveJob) {
      pollingTimerRef.current = setTimeout(() => {
        // Atualiza a página silenciosamente
        fetchBooks(pagination.page, false);
      }, 3500);
    }

    return () => {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
    };
  }, [books, pagination.page, fetchBooks]);

  return (
    <section aria-labelledby="library-heading">
      <div className="section-header">
        <div>
          <h1 id="library-heading" className="section-title">
            Biblioteca de Obras
          </h1>
          <p className="section-description">
            Gerencie os livros cadastrados, acompanhe o processamento de chunks e prepare o acervo para o chatbot.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => fetchBooks(pagination.page, true)}
            disabled={isLoading}
            title="Atualizar lista de livros"
          >
            <span aria-hidden="true">↻</span>
            Atualizar
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAddModalOpen(true)}
          >
            <span aria-hidden="true">➕</span>
            Cadastrar Livro
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="alert alert-danger" role="alert">
          <span aria-hidden="true">⚠️</span>
          <div style={{ flex: 1 }}>{errorMessage}</div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => fetchBooks(pagination.page, true)}
          >
            Tentar Novamente
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="state-box" aria-live="polite">
          <div className="spinner spinner-dark" style={{ width: '2rem', height: '2rem', margin: '0 auto 1rem' }}></div>
          <p style={{ fontWeight: '600' }}>Carregando biblioteca de livros...</p>
        </div>
      ) : books.length === 0 ? (
        <div className="state-box">
          <div className="state-icon" aria-hidden="true">📚</div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '0.5rem' }}>
            Nenhum livro cadastrado no momento
          </h2>
          <p style={{ color: 'var(--text-muted)', maxWidth: '440px', margin: '0 auto 1.5rem' }}>
            Adicione sua primeira obra literária ou documento em formato TXT para iniciar o pipeline de embeddings RAG.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setIsAddModalOpen(true)}
          >
            Cadastrar Primeiro Livro
          </button>
        </div>
      ) : (
        <>
          <div className="books-grid">
            {books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onSelectForChat={onSelectBookForChat}
                onStartIngest={handleStartIngest}
                onRefreshStatus={refreshSingleBookStatus}
                isUpdating={updatingBookIds.has(book.id)}
              />
            ))}
          </div>

          {pagination.totalPages > 1 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: '1rem',
                marginTop: '2rem',
                paddingTop: '1rem',
                borderTop: '1px solid var(--border-color)',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchBooks(pagination.page - 1, true)}
                disabled={pagination.page <= 1 || isLoading}
              >
                ← Anterior
              </button>

              <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                Página {pagination.page} de {pagination.totalPages} ({pagination.total} livros)
              </span>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchBooks(pagination.page + 1, true)}
                disabled={pagination.page >= pagination.totalPages || isLoading}
              >
                Próxima →
              </button>
            </div>
          )}
        </>
      )}

      <AddBookModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onBookAdded={handleBookAdded}
      />
    </section>
  );
}
