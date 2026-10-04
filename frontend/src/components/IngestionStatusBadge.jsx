import React from 'react';

/**
 * Componente que renderiza um badge acessível com o estado atual da ingestão.
 *
 * @param {object} props
 * @param {string|null} props.status - 'queued' | 'running' | 'waiting_retry' | 'completed' | 'failed' | null
 * @param {boolean} [props.hasEmbeddings=false]
 */
export function IngestionStatusBadge({ status, hasEmbeddings = false }) {
  if (!status) {
    if (hasEmbeddings) {
      return (
        <span className="badge badge-success" title="Embeddings ativos disponíveis no acervo">
          ● Pronto para Chat
        </span>
      );
    }
    return (
      <span className="badge badge-neutral" title="Livro ainda não processado">
        ○ Não Ingerido
      </span>
    );
  }

  switch (status) {
    case 'completed':
      return (
        <span className="badge badge-success" title="Ingestão finalizada com sucesso">
          ✓ Ingestão Concluída
        </span>
      );
    case 'running':
      return (
        <span className="badge badge-info" title="Processamento de embeddings em andamento">
          <span className="spinner spinner-dark" style={{ width: '0.625rem', height: '0.625rem' }}></span>
          Processando Chunks
        </span>
      );
    case 'queued':
      return (
        <span className="badge badge-warning" title="Aguardando liberação na fila de processamento">
          ⏳ Na Fila
        </span>
      );
    case 'waiting_retry':
      return (
        <span className="badge badge-warning" title="Pausa temporária aguardando janela de quota da API">
          ⏳ Aguardando Quota (429)
        </span>
      );
    case 'failed':
      return (
        <span className="badge badge-danger" title="Ocorreu um erro durante a ingestão">
          ✕ Falha na Ingestão
        </span>
      );
    default:
      return <span className="badge badge-neutral">{status}</span>;
  }
}
