import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar.jsx';
import { BookList } from './components/BookList.jsx';
import { ChatView } from './components/ChatView.jsx';
import { checkBackendHealth } from './api.js';

export function App() {
  const [activeTab, setActiveTab] = useState('library'); // 'library' | 'chat'
  const [selectedBookForChat, setSelectedBookForChat] = useState(null);
  const [isApiOnline, setIsApiOnline] = useState(null);

  // Monitora o status de conectividade com a API Fastify
  useEffect(() => {
    let isMounted = true;

    async function probeApi() {
      const isOnline = await checkBackendHealth();
      if (isMounted) {
        setIsApiOnline(isOnline);
      }
    }

    probeApi();
    const interval = setInterval(probeApi, 10000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleSelectBookForChat = (bookId) => {
    setSelectedBookForChat(bookId);
    setActiveTab('chat');
  };

  return (
    <div className="app-container">
      <Navbar
        activeTab={activeTab}
        onSelectTab={(tab) => {
          if (tab === 'library') {
            // Mantém ou limpa conforme necessidade
          }
          setActiveTab(tab);
        }}
        isApiOnline={isApiOnline}
      />

      <main className="main-content">
        {isApiOnline === false && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden="true">⚠️</span>
            <div>
              <strong>Servidor backend inacessível:</strong> Não foi possível conectar à API Fastify.
              Certifique-se de que o backend está em execução na porta 3000 (<code>npm run dev</code>).
            </div>
          </div>
        )}

        {activeTab === 'library' ? (
          <BookList onSelectBookForChat={handleSelectBookForChat} />
        ) : (
          <ChatView
            initialBookId={selectedBookForChat}
            onGoToLibrary={() => setActiveTab('library')}
          />
        )}
      </main>
    </div>
  );
}

export default App;
