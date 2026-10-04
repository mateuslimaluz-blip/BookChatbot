import React from 'react';
import { IngestionStatusBadge } from './IngestionStatusBadge.jsx';

/**
 * Card individual representando um livro cadastrado na Biblioteca.
 *
 * @param {object} props
 * @param {object} props.book
 * @param {function} props.onSelectForChat - Seleciona este livro para conversa no Chat RAG
 * @param {function} props.onStartIngest - Dispara enfileiramento manual de ingestão
 * @param {function} props.onRefreshStatus - Atualiza o status pontual deste livro
 * @param {boolean} props.isUpdating
 */
export function BookCard({
  book,
  onSelectForChat,
  onStartIngest,
  onRefreshStatus,
  isUpdating = false,
}) {
  const latestJob = book.latestJob;
  const status = latestJob?.status || null;
  const isProcessing = status === 'running' || status === 'queued' || status === 'waiting_retry';
  const progress = latestJob?.progressPercentage || 0;

  const formattedDate = book.createdAt
    ? new Date(book.createdAt).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    : 'Data não disponível';

  return (
    <article className="book-card" aria-labelledby={`book-title-${book.id}`}>
      <div className="book-card-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
          <h3 id={`book-title-${book.id}`} className="book-title">
            {book.title}
          </h3>
          <IngestionStatusBadge status={status} hasEmbeddings={book.hasEmbeddings} />
        </div>
        <p className="book-author">por {book.author}</p>
        <p className="book-meta">Cadastrado em: {formattedDate}</p>
      </div>

      <div className="book-status-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Status de Processamento:</span>
          <span style={{ fontWeight: '600' }}>
            {status === 'completed'
              ? 'Pronto para perguntas'
              : status === 'running'
              ? `Processando (${progress}%)`
              : status === 'queued'
              ? 'Aguardando worker'
              : status === 'waiting_retry'
              ? 'Pausa temporária de cota'
              : status === 'failed'
              ? 'Falha registrada'
              : 'Pendente de ingestão'}
          </span>
        </div>

        {isProcessing && (
          <div>
            <div className="progress-bar-container" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100">
              <div className="progress-bar-fill" style={{ width: `${Math.max(5, progress)}%` }}></div>
            </div>
            {latestJob?.totalChunks > 0 && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', textAlign: 'right' }}>
                {latestJob.completedChunks} de {latestJob.totalChunks} chunks processados
              </p>
            )}
          </div>
        )}

        {status === 'failed' && latestJob?.errorMessage && (
          <p style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: '0.25rem' }}>
            Motivo: {latestJob.errorMessage}
          </p>
        )}
      </div>

      <div className="book-card-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ flex: 1 }}
          onClick={() => onSelectForChat(book.id)}
          disabled={!book.hasEmbeddings}
          title={book.hasEmbeddings ? 'Abrir chat focado neste livro' : 'Necessário concluir a ingestão antes de conversar'}
        >
          <span aria-hidden="true">💬</span>
          Conversar
        </button>

        {(!book.hasEmbeddings || status === 'failed') && !isProcessing && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onStartIngest(book.id)}
            title="Iniciar o cálculo dos embeddings para este livro"
          >
            Iniciar Ingestão
          </button>
        )}

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onRefreshStatus(book.id)}
          disabled={isUpdating}
          title="Verificar status atualizado deste livro"
          aria-label="Atualizar status do livro"
        >
          {isUpdating ? <span className="spinner spinner-dark" style={{ width: '0.75rem', height: '0.75rem' }}></span> : '↻'}
        </button>
      </div>
    </article>
  );
}
