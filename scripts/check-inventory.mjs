import { pool } from '../src/config/db.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

console.log('====================================================');
console.log('   INVENTÁRIO DO ACERVO — BOOKCHATBOT              ');
console.log('====================================================\n');

try {
  // 1. Consulta dinâmica das obras cadastradas e seus embeddings
  const res = await pool.query(`
    SELECT 
      b.id, 
      b.title, 
      b.author, 
      b.content_path,
      count(be.id) AS embeddings_count
    FROM books b 
    LEFT JOIN book_embeddings be ON be.book_id = b.id 
    GROUP BY b.id, b.title, b.author, b.content_path 
    ORDER BY b.title ASC
  `);

  const storageDir = join(process.cwd(), 'storage', 'books');
  const transferBooksDir = join(process.cwd(), 'transfer', 'books');

  let totalEmbeddings = 0;
  const dbReferencedFiles = new Set();
  const discrepancies = [];

  console.log(`1. OBRAS CADASTRADAS NO BANCO DE DADOS (${res.rows.length} no total):\n`);

  for (const row of res.rows) {
    const count = parseInt(row.embeddings_count, 10);
    totalEmbeddings += count;

    const rawPath = row.content_path || '';
    const fileName = rawPath ? basename(rawPath) : null;
    if (fileName) {
      dbReferencedFiles.add(fileName);
    }

    // Checagem em storage/books/
    let storageStatus = 'Não configurado';
    let storageSize = 0;
    if (fileName) {
      const storageFilePath = join(storageDir, fileName);
      if (existsSync(storageFilePath)) {
        try {
          const st = statSync(storageFilePath);
          if (st.isFile()) {
            storageStatus = `Presente (${st.size.toLocaleString('pt-BR')} bytes)`;
            storageSize = st.size;
          } else {
            storageStatus = 'ERRO: Não é arquivo regular (diretório)';
            discrepancies.push(`[STORAGE] "${fileName}" não é um arquivo regular.`);
          }
        } catch (err) {
          storageStatus = `ERRO de leitura: ${err.message}`;
          discrepancies.push(`[STORAGE] Falha ao ler "${fileName}": ${err.message}`);
        }
      } else {
        storageStatus = 'AUSENTE';
        discrepancies.push(`[STORAGE] Arquivo "${fileName}" (livro: "${row.title}") não existe em storage/books/.`);
      }
    }

    // Checagem em transfer/books/
    let transferStatus = 'Não configurado';
    let transferSize = 0;
    if (fileName) {
      const transferFilePath = join(transferBooksDir, fileName);
      if (existsSync(transferFilePath)) {
        try {
          const st = statSync(transferFilePath);
          if (st.isFile()) {
            transferStatus = `Presente (${st.size.toLocaleString('pt-BR')} bytes)`;
            transferSize = st.size;
          } else {
            transferStatus = 'ERRO: Não é arquivo regular';
            discrepancies.push(`[TRANSFER] "${fileName}" não é um arquivo regular.`);
          }
        } catch (err) {
          transferStatus = `ERRO de leitura: ${err.message}`;
          discrepancies.push(`[TRANSFER] Falha ao ler "${fileName}": ${err.message}`);
        }
      } else {
        transferStatus = 'AUSENTE';
        discrepancies.push(`[TRANSFER] Arquivo "${fileName}" (livro: "${row.title}") não foi exportado para transfer/books/.`);
      }
    }

    // Alerta de divergência de tamanho entre storage e transfer
    if (storageSize > 0 && transferSize > 0 && storageSize !== transferSize) {
      discrepancies.push(
        `[TAMANHO] Diferença no arquivo "${fileName}": storage (${storageSize} B) vs transfer (${transferSize} B).`
      );
    }

    console.log(`• Título: "${row.title}"`);
    console.log(`  Autor:  ${row.author || 'N/D'}`);
    console.log(`  UUID:   ${row.id}`);
    console.log(`  Chunks / Embeddings: ${count}`);
    console.log(`  Arquivo DB (content_path): ${row.content_path || '(não informado)'}`);
    console.log(`  Status em storage/books/:  ${storageStatus}`);
    console.log(`  Status em transfer/books/: ${transferStatus}`);
    console.log('');
  }

  console.log(`TOTAL GERAL DE EMBEDDINGS NO BANCO: ${totalEmbeddings}\n`);

  // 2. Cruzamento com arquivos físicos nos diretórios (detecção de órfãos e sobras)
  console.log('2. VERIFICAÇÃO DE ARQUIVOS FÍSICOS EM DISCO:\n');

  const inspectDirectory = (dirPath, label) => {
    if (!existsSync(dirPath)) {
      console.log(`Diretório ${label} não existe.\n`);
      return;
    }

    const entries = readdirSync(dirPath, { withFileTypes: true });
    console.log(`Itens em ${label} (${entries.length} encontrados):`);

    for (const entry of entries) {
      const isFile = entry.isFile();
      const isDir = entry.isDirectory();
      const isReferenced = dbReferencedFiles.has(entry.name);

      let detail = '';
      if (isDir) {
        detail = '⚠️ [DIRETÓRIO RESIDUAL — não é arquivo de livro]';
        discrepancies.push(`[${label}] Diretório residual encontrado: "${entry.name}"`);
      } else if (!isReferenced) {
        detail = 'ℹ️ [ARQUIVO ÓRFÃO / NÃO VINCULADO AO BANCO ATUAL]';
      } else {
        const fullPath = join(dirPath, entry.name);
        const size = statSync(fullPath).size;
        detail = `✓ Vinculado ao banco (${size.toLocaleString('pt-BR')} bytes)`;
      }

      console.log(`  - ${entry.name}: ${detail}`);
    }
    console.log('');
  };

  inspectDirectory(storageDir, 'storage/books/');
  inspectDirectory(transferBooksDir, 'transfer/books/');

  // 3. Verificação dos arquivos de dump em transfer/
  console.log('3. VERIFICAÇÃO DOS ARQUIVOS DE DUMP EM transfer/:\n');
  const transferDir = join(process.cwd(), 'transfer');
  const dumpBinPath = join(transferDir, 'bookchatbot_staging.dump');
  const dumpSqlPath = join(transferDir, 'bookchatbot_staging.sql');

  if (existsSync(dumpBinPath)) {
    const binStat = statSync(dumpBinPath);
    console.log(`  ✓ Dump binário (bookchatbot_staging.dump): ${(binStat.size / (1024 * 1024)).toFixed(2)} MB`);
  } else {
    console.log(`  ⚠️ Dump binário não encontrado em ${dumpBinPath}`);
    discrepancies.push('[DUMP] Arquivo bookchatbot_staging.dump ausente.');
  }

  if (existsSync(dumpSqlPath)) {
    const sqlStat = statSync(dumpSqlPath);
    console.log(`  ✓ Dump SQL (bookchatbot_staging.sql): ${(sqlStat.size / (1024 * 1024)).toFixed(2)} MB`);
  } else {
    console.log(`  ⚠️ Dump SQL não encontrado em ${dumpSqlPath}`);
    discrepancies.push('[DUMP] Arquivo bookchatbot_staging.sql ausente.');
  }
  console.log('');

  // 4. Diagnóstico final de integridade
  console.log('====================================================');
  console.log('   DIAGNÓSTICO FINAL DE INTEGRIDADE                ');
  console.log('====================================================');
  if (discrepancies.length === 0) {
    console.log('STATUS: ✅ INTEGRIDADE PERFEITA (Paridade 100% entre banco, storage e transfer)');
  } else {
    console.log(`STATUS: ⚠️ ATENÇÃO (${discrepancies.length} observações encontradas):`);
    for (const d of discrepancies) {
      console.log(`  • ${d}`);
    }
  }
  console.log('====================================================\n');

} catch (error) {
  console.error('Erro ao consultar inventário:', error.message);
} finally {
  await pool.end();
}
