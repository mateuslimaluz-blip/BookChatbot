import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AddBookModal } from './components/AddBookModal.jsx';
import { BookList } from './components/BookList.jsx';
import { ChatView } from './components/ChatView.jsx';
import { listBooks, checkBackendHealth } from './api.js';

/**
 * App - Shell principal do BookChatbot
 * Gerencia a barra lateral (recolhida / expandida), a visualização ativa (Chat / Biblioteca),
 * o estado de seleção de livros e a integração com o modal de cadastro/upload.
 */
export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState('chat'); // 'chat' | 'library'
  const [selectedBookId, setSelectedBookId] = useState('');
  const [books, setBooks] = useState([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isApiOnline, setIsApiOnline] = useState(null);
  const [topMenuOpen, setTopMenuOpen] = useState(false);

  const chatViewRef = useRef(null);
  const topMenuRef = useRef(null);

  // Carrega lista de livros para alimentar o acervo da barra lateral e o seletor de contexto
  const fetchBooks = useCallback(async () => {
    try {
      const data = await listBooks({ page: 1, limit: 100 });
      setBooks(data.books || []);
    } catch (err) {
      console.warn('Não foi possível carregar livros para a barra lateral:', err.message);
    }
  }, []);

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  // Monitora a conectividade com o backend Fastify
  useEffect(() => {
    let isMounted = true;
    async function probe() {
      const ok = await checkBackendHealth();
      if (isMounted) setIsApiOnline(ok);
    }
    probe();
    const interval = setInterval(probe, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Fecha menu de 3 pontinhos ao clicar fora
  useEffect(() => {
    function handleClickOutside(e) {
      if (topMenuOpen && topMenuRef.current && !topMenuRef.current.contains(e.target)) {
        setTopMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [topMenuOpen]);

  // Ação ao concluir upload com sucesso
  const handleBookAdded = () => {
    setIsAddModalOpen(false);
    fetchBooks();
  };

  const handleSelectBook = (bookId) => {
    setSelectedBookId(bookId);
    setActiveView('chat');
    // Em telas móveis, fecha a sidebar ao selecionar
    if (window.innerWidth <= 768) {
      setSidebarOpen(false);
    }
  };

  const handleNewChat = () => {
    setActiveView('chat');
    chatViewRef.current?.resetChat();
    setSidebarOpen(false);
    setTopMenuOpen(false);
  };

  return (
    <div className="shell">
      {/* OVERLAY PARA VIEWPORT ESTREITO / MOBILE */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* BARRA LATERAL (RECOLHIDA OU EXPANDIDA - IMAGENS 1 E 2) */}
      <aside
        className={`sidebar ${sidebarOpen ? 'sidebar--open' : 'sidebar--collapsed'}`}
        aria-label="Navegação da aplicação"
      >
        {/* TOPO DA BARRA LATERAL */}
        <div className="sidebar-header-section">
          {/* Botão de Livro / Bookmark: expande/recolhe a navegação (Interação 2) */}
          <button
            type="button"
            className="sidebar-action-btn sidebar-action-btn--primary"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Recolher navegação' : 'Expandir navegação (Livros e Conversas)'}
            aria-expanded={sidebarOpen}
            aria-label="Alternar barra lateral"
          >
            <BookRibbonIcon />
            {sidebarOpen && <span className="sidebar-brand-name">BookChatbot</span>}
          </button>

          {/* Botão Explorar Biblioteca Completa */}
          <button
            type="button"
            className={`sidebar-action-btn ${activeView === 'library' ? 'sidebar-action-btn--active' : ''}`}
            onClick={() => {
              setActiveView('library');
              if (window.innerWidth <= 768) setSidebarOpen(false);
            }}
            title="Abrir acervo completo de livros"
            aria-label="Abrir acervo de livros"
          >
            <ExternalWindowIcon />
            {sidebarOpen && <span className="sidebar-btn-label">Biblioteca</span>}
          </button>

          {/* Botão de Busca (em breve) */}
          <button
            type="button"
            className="sidebar-action-btn sidebar-action-btn--disabled"
            title="Pesquisar no acervo"
            aria-label="Pesquisar"
            disabled
          >
            <SearchLensIcon />
            {sidebarOpen && <span className="sidebar-btn-label">Pesquisa</span>}
          </button>
        </div>

        {/* CONTEÚDO EXPANDIDO (IMAGEM 1): Navegação, conversas e lista de livros */}
        {sidebarOpen && (
          <div className="sidebar-expanded-content">
            <button
              type="button"
              className="sidebar-btn-newchat"
              onClick={handleNewChat}
            >
              <span>+</span>
              <span>Nova Conversa</span>
            </button>

            {/* SEÇÃO DE LIVROS NO ACERVO */}
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <span>LIVROS NO ACERVO ({books.length})</span>
                <button
                  type="button"
                  className="sidebar-add-link"
                  onClick={() => setIsAddModalOpen(true)}
                  title="Cadastrar novo livro"
                >
                  + Adicionar
                </button>
              </div>

              <div className="sidebar-books-list">
                {/* Opção Acervo Geral */}
                <button
                  type="button"
                  className={`sidebar-book-item ${selectedBookId === '' ? 'sidebar-book-item--selected' : ''}`}
                  onClick={() => handleSelectBook('')}
                >
                  <div className="sidebar-book-icon">🌐</div>
                  <div className="sidebar-book-info">
                    <div className="sidebar-book-title">Acervo Geral</div>
                    <div className="sidebar-book-sub">Buscar em todas as obras</div>
                  </div>
                </button>

                {/* Lista de livros cadastrados */}
                {books.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`sidebar-book-item ${selectedBookId === b.id ? 'sidebar-book-item--selected' : ''}`}
                    onClick={() => handleSelectBook(b.id)}
                    title={`${b.title} — ${b.author || 'Autor desconhecido'}`}
                  >
                    <div className="sidebar-book-icon">📖</div>
                    <div className="sidebar-book-info">
                      <div className="sidebar-book-title">{b.title}</div>
                      <div className="sidebar-book-sub">
                        {b.author || 'Autor n/d'} •{' '}
                        {b.hasEmbeddings ? (
                          <span className="status-dot status-dot--ready">Pronto</span>
                        ) : (
                          <span className="status-dot status-dot--pending">Pendente</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}

                {books.length === 0 && (
                  <div className="sidebar-empty-books">
                    Nenhum livro cadastrado. Clique em "+ Adicionar" para fazer upload de um TXT.
                  </div>
                )}
              </div>
            </div>

            {/* ATALHO PARA GERENCIADOR COMPLETO */}
            <div className="sidebar-manage-box">
              <button
                type="button"
                className="sidebar-manage-btn"
                onClick={() => {
                  setActiveView('library');
                  if (window.innerWidth <= 768) setSidebarOpen(false);
                }}
              >
                Gerenciar acervo completo →
              </button>
            </div>
          </div>
        )}

        {/* RODAPÉ DA BARRA LATERAL (Avatar do usuário) */}
        <div className="sidebar-footer-section">
          <div className="sidebar-user-pill" title="Usuário conectado">
            <div className="sidebar-avatar-circle">
              <UserSilhouetteIcon />
            </div>
            {sidebarOpen && (
              <div className="sidebar-user-details">
                <span className="sidebar-user-name">Usuário</span>
                <span className={`sidebar-user-status ${isApiOnline ? 'is-online' : 'is-offline'}`}>
                  {isApiOnline === false ? 'API desconectada' : 'API conectada'}
                </span>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ÁREA PRINCIPAL DA APLICAÇÃO */}
      <main className="main-viewport">
        {/* BARRA SUPERIOR (MENU 3 PONTINHOS E STATUS) */}
        <header className="topbar">
          {isApiOnline === false && (
            <div className="topbar-offline-warning" role="alert">
              ⚠️ Backend Fastify inacessível na porta 3000 (<code>npm run dev</code>)
            </div>
          )}

          <div className="topbar-actions" ref={topMenuRef}>
            <button
              type="button"
              className="topbar-kebab-btn"
              onClick={() => setTopMenuOpen((v) => !v)}
              aria-label="Opções do sistema"
              aria-expanded={topMenuOpen}
            >
              ⋮
            </button>

            {topMenuOpen && (
              <div className="topbar-popover-menu" role="menu">
                <button
                  type="button"
                  className="topbar-popover-item"
                  onClick={handleNewChat}
                  role="menuitem"
                >
                  💬 Nova Conversa
                </button>
                <button
                  type="button"
                  className="topbar-popover-item"
                  onClick={() => {
                    setActiveView('library');
                    setTopMenuOpen(false);
                  }}
                  role="menuitem"
                >
                  📚 Biblioteca Completa
                </button>
                <button
                  type="button"
                  className="topbar-popover-item"
                  onClick={() => {
                    setIsAddModalOpen(true);
                    setTopMenuOpen(false);
                  }}
                  role="menuitem"
                >
                  ➕ Adicionar Livro (TXT)
                </button>
                <hr className="topbar-popover-divider" />
                <button
                  type="button"
                  className="topbar-popover-item"
                  onClick={() => {
                    fetchBooks();
                    checkBackendHealth().then((ok) => setIsApiOnline(ok));
                    setTopMenuOpen(false);
                  }}
                  role="menuitem"
                >
                  🔄 Recarregar Status
                </button>
              </div>
            )}
          </div>
        </header>

        {/* CONTEÚDO PRINCIPAL (CHAT OU BIBLIOTECA) */}
        <div className="main-stage">
          {activeView === 'chat' ? (
            <ChatView
              ref={chatViewRef}
              selectedBookId={selectedBookId}
              onSelectBookId={setSelectedBookId}
              availableBooks={books}
              onOpenAddBookModal={() => setIsAddModalOpen(true)}
              onRefreshBooks={fetchBooks}
            />
          ) : (
            <div className="library-container">
              <div className="library-top-nav">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setActiveView('chat')}
                >
                  ← Voltar ao Chat
                </button>
              </div>
              <BookList
                onSelectBookForChat={(bookId) => {
                  setSelectedBookId(bookId);
                  setActiveView('chat');
                }}
              />
            </div>
          )}
        </div>
      </main>

      {/* MODAL DE CADASTRO/UPLOAD DE LIVRO */}
      <AddBookModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onBookAdded={handleBookAdded}
      />
    </div>
  );
}

/* ── ÍCONES SVG DA BARRA LATERAL ────────────────────────────────────── */

function BookRibbonIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <line x1="12" y1="2" x2="12" y2="10" />
      <polyline points="12 10 10 8 12 6" />
    </svg>
  );
}

function ExternalWindowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function SearchLensIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function UserSilhouetteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
    </svg>
  );
}

export default App;
