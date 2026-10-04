import React from 'react';

/**
 * Barra de navegação principal da aplicação.
 *
 * @param {object} props
 * @param {'library'|'chat'} props.activeTab
 * @param {function} props.onSelectTab
 * @param {boolean|null} props.isApiOnline
 */
export function Navbar({ activeTab, onSelectTab, isApiOnline }) {
  return (
    <header className="navbar">
      <div className="navbar-content">
        <a href="#home" className="brand" onClick={(e) => { e.preventDefault(); onSelectTab('library'); }}>
          <div className="brand-icon" aria-hidden="true">📖</div>
          <div>
            <span className="brand-title">BookChatbot</span>
            <span className="brand-subtitle">RAG com Google Gemini & pgvector</span>
          </div>
        </a>

        <nav className="nav-links" aria-label="Navegação Principal">
          <button
            type="button"
            className={`nav-button ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => onSelectTab('library')}
            aria-current={activeTab === 'library' ? 'page' : undefined}
          >
            <span aria-hidden="true">📚</span>
            Biblioteca de Livros
          </button>

          <button
            type="button"
            className={`nav-button ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => onSelectTab('chat')}
            aria-current={activeTab === 'chat' ? 'page' : undefined}
          >
            <span aria-hidden="true">💬</span>
            Chat RAG
          </button>

          {isApiOnline !== null && (
            <div
              style={{
                marginLeft: '0.5rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.75rem',
                fontWeight: '600',
                color: isApiOnline ? 'var(--success)' : 'var(--danger)',
              }}
              title={isApiOnline ? 'API Conectada e Pronta' : 'API Indisponível'}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: isApiOnline ? 'var(--success)' : 'var(--danger)',
                }}
              ></span>
              {isApiOnline ? 'API Conectada' : 'Offline'}
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}
