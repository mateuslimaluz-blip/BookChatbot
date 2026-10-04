import React, { useState } from 'react';
import { createBook, ingestBook } from '../api.js';

/**
 * Modal de cadastro de novo livro via upload de arquivo TXT.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {function} props.onClose
 * @param {function} props.onBookAdded - Chamado após cadastro e início do enfileiramento com o novo bookId
 */
export function AddBookModal({ isOpen, onClose, onBookAdded }) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusStep, setStatusStep] = useState('');
  const [errorMessage, setErrorMessage] = useState(null);

  if (!isOpen) return null;

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      setSelectedFile(null);
      return;
    }

    if (!file.name.toLowerCase().endsWith('.txt')) {
      setErrorMessage('Apenas arquivos de texto (.txt) são aceitos pelo sistema.');
      setSelectedFile(null);
      return;
    }

    if (file.size === 0) {
      setErrorMessage('O arquivo selecionado está vazio (0 bytes).');
      setSelectedFile(null);
      return;
    }

    // 5MB em bytes
    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage('O arquivo excede o limite máximo permitido de upload (5MB).');
      setSelectedFile(null);
      return;
    }

    setErrorMessage(null);
    setSelectedFile(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!title.trim()) {
      setErrorMessage('Por favor, informe o título do livro.');
      return;
    }

    if (!author.trim()) {
      setErrorMessage('Por favor, informe o autor do livro.');
      return;
    }

    if (!selectedFile) {
      setErrorMessage('Por favor, selecione um arquivo .txt para upload.');
      return;
    }

    setIsSubmitting(true);
    setStatusStep('Enviando arquivo e cadastrando livro...');

    let createdBookId = null;

    try {
      // 1. Cadastra o livro enviando multipart/form-data
      const createResult = await createBook({
        title,
        author,
        file: selectedFile,
      });

      const book = createResult?.book;
      if (!book?.id) {
        throw new Error('A API não retornou o identificador do livro cadastrado.');
      }

      createdBookId = book.id;
      setStatusStep('Livro cadastrado! Iniciando enfileiramento da ingestão...');

      // 2. Chama imediatamente o enfileiramento da ingestão RAG
      try {
        await ingestBook(createdBookId);
      } catch (ingestErr) {
        // Se falhar a chamada de ingestão, o livro já foi salvo, então apenas notificamos o usuário
        console.warn('Falha ao enfileirar ingestão automática:', ingestErr.message);
      }

      // Notifica o componente pai para atualizar a listagem e começar a rastrear o livro
      onBookAdded(book);
      onClose();
    } catch (err) {
      setErrorMessage(err.message || 'Erro ao cadastrar o livro. Verifique os dados e tente novamente.');
    } finally {
      setIsSubmitting(false);
      setStatusStep('');
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-card">
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            Cadastrar Novo Livro
          </h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Fechar modal"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {errorMessage && (
              <div className="alert alert-danger" role="alert">
                <span aria-hidden="true">⚠️</span>
                <div>{errorMessage}</div>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="book-title" className="form-label">
                Título da Obra <span style={{ color: 'var(--danger)' }}>*</span>
              </label>
              <input
                id="book-title"
                type="text"
                className="form-input"
                placeholder="Ex: Dom Casmurro"
                maxLength={255}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="book-author" className="form-label">
                Autor(a) <span style={{ color: 'var(--danger)' }}>*</span>
              </label>
              <input
                id="book-author"
                type="text"
                className="form-input"
                placeholder="Ex: Machado de Assis"
                maxLength={255}
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="book-file" className="form-label">
                Arquivo de Texto (.TXT) <span style={{ color: 'var(--danger)' }}>*</span>
              </label>
              <input
                id="book-file"
                type="file"
                accept=".txt,text/plain"
                onChange={handleFileChange}
                disabled={isSubmitting}
                style={{ display: 'block', width: '100%', fontSize: '0.875rem' }}
                required
              />
              <p className="form-hint">
                Apenas texto simples UTF-8 (máximo de 5MB). O arquivo será dividido em chunks e processado para busca semântica.
              </p>
            </div>

            {isSubmitting && statusStep && (
              <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--primary)' }}>
                <span className="spinner spinner-dark"></span>
                <span>{statusStep}</span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Salvando...' : 'Cadastrar e Iniciar Ingestão'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
