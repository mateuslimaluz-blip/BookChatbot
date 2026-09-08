#  BookBot

Chatbot desenvolvido para auxiliar usuários na leitura e compreensão de livros por meio de inteligência artificial.

##  Sobre o projeto

O BookBot permite que o usuário selecione uma obra e converse com um chatbot sobre seu conteúdo.

O sistema será capaz de responder perguntas sobre personagens, acontecimentos, capítulos e outros aspectos dos livros. Além disso, contará com uma base de conhecimento baseada em um dicionário em PDF para auxiliar na compreensão de palavras e expressões desconhecidas.

##  Problema

Leitores podem encontrar dificuldades para compreender palavras, expressões, personagens e acontecimentos presentes em livros, especialmente em obras com linguagem mais antiga ou complexa.

##  Funcionalidades previstas

- [ ] Cadastro e seleção de livros
- [ ] Chatbot com inteligência artificial
- [ ] Perguntas sobre personagens e acontecimentos
- [ ] Consulta sobre capítulos e trechos
- [ ] Busca por palavras e expressões
- [ ] Consulta ao dicionário
- [ ] Respostas contextualizadas
- [ ] Histórico de conversas
- [ ] Resumo de capítulos e trechos

##  Stacks

### Frontend
- React
- TypeScript
- Tailwind CSS

### Backend
- Node.js
- TypeScript
- Fastify

### Banco de dados
- PostgreSQL
- Drizzle ORM
- pgvector

### Inteligência Artificial
- API de modelo de linguagem
- RAG (Retrieval-Augmented Generation)

##  Arquitetura

```text
Usuário
   ↓
Frontend
   ↓
Backend / API
   ↓
┌───────────────┬───────────────┐
│               │               │
Banco         RAG              IA
│               │               │
└───────────────┴───────────────┘
                ↓
             Resposta
