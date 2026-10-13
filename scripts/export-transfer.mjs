import { pool } from '../src/config/db.js';
import { readdirSync, copyFileSync, mkdirSync, statSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

console.log('====================================================');
console.log('   EXPORTAÇÃO DO PACOTE DE TRANSFERÊNCIA           ');
console.log('====================================================\n');

const storageDir = join(process.cwd(), 'storage', 'books');
const transferDir = join(process.cwd(), 'transfer');
const transferBooksDir = join(transferDir, 'books');

mkdirSync(transferBooksDir, { recursive: true });

// 1. Sincronização segura de arquivos de texto de storage/books para transfer/books
console.log('1. Sincronizando arquivos de texto das obras...');
if (existsSync(storageDir)) {
  const items = readdirSync(storageDir);
  let copiedCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    const srcPath = join(storageDir, item);
    const destPath = join(transferBooksDir, item);
    try {
      const st = statSync(srcPath);
      if (st.isFile()) {
        copyFileSync(srcPath, destPath);
        copiedCount++;
        console.log(`   ✓ Sincronizado: "${item}" (${st.size.toLocaleString('pt-BR')} bytes)`);
      } else {
        skippedCount++;
        console.log(`   ℹ️ Ignorado (não é arquivo regular): "${item}"`);
      }
    } catch (err) {
      console.warn(`   ⚠️ Erro ao copiar "${item}": ${err.message}`);
    }
  }
  console.log(`   Total de arquivos sincronizados: ${copiedCount} (ignorados: ${skippedCount})\n`);
} else {
  console.log('   Aviso: diretório storage/books não encontrado.\n');
}

// 2. Consulta dinâmica do inventário no banco de dados
console.log('2. Consultando acervo cadastrado no banco de dados...');
let totalEmbeddings = 0;
let booksCount = 0;

try {
  const res = await pool.query(`
    SELECT 
      b.id, 
      b.title, 
      b.author, 
      count(be.id) AS embeddings_count
    FROM books b 
    LEFT JOIN book_embeddings be ON be.book_id = b.id 
    GROUP BY b.id, b.title, b.author 
    ORDER BY b.title ASC
  `);

  booksCount = res.rows.length;
  console.log(`   Total de obras cadastradas no banco: ${booksCount}`);
  for (const row of res.rows) {
    const c = parseInt(row.embeddings_count, 10);
    totalEmbeddings += c;
    console.log(`   • "${row.title}" (${row.author || 'Autor não informado'}): ${c} chunks`);
  }
  console.log(`   Total acumulado de embeddings: ${totalEmbeddings}\n`);
} catch (dbErr) {
  console.error('   ⚠️ Falha ao consultar o banco de dados:', dbErr.message);
}

// 3. Geração segura de novos dumps a partir do PostgreSQL (Docker)
console.log('3. Exportando dumps atualizados do PostgreSQL (pg_dump)...');

const containerName = 'bookchatbot-postgres-staging';
let dockerAvailable = false;
let containerRunning = false;

try {
  const dockerCheck = execSync('docker ps --format "{{.Names}}"', {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  dockerAvailable = true;
  const runningContainers = dockerCheck.split(/\r?\n/).map((s) => s.trim());
  containerRunning = runningContainers.includes(containerName);
} catch {
  dockerAvailable = false;
  containerRunning = false;
}

if (!dockerAvailable) {
  console.log('   ℹ️ Docker CLI não disponível no ambiente atual.');
  console.log('   Os dumps existentes em transfer/ foram preservados intactos.\n');
} else if (!containerRunning) {
  console.log(`   ℹ️ O container "${containerName}" não está em execução.`);
  console.log('   Inicie o container com `docker compose -f docker-compose.staging.yml up -d` para gerar novos dumps.');
  console.log('   Os dumps existentes em transfer/ foram preservados intactos.\n');
} else {
  console.log(`   Container "${containerName}" detectado ativo.`);
  
  const dumpBinFinal = join(transferDir, 'bookchatbot_staging.dump');
  const dumpSqlFinal = join(transferDir, 'bookchatbot_staging.sql');
  const dumpBinTmp = join(transferDir, 'bookchatbot_staging.dump.tmp');
  const dumpSqlTmp = join(transferDir, 'bookchatbot_staging.sql.tmp');

  let binSuccess = false;
  let sqlSuccess = false;

  // Dump Binário (-Fc)
  try {
    execSync(
      `docker exec ${containerName} pg_dump -U bookchatbot -d bookchatbot_staging -Fc -f /tmp/staging_export.dump`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    execSync(
      `docker cp ${containerName}:/tmp/staging_export.dump "${dumpBinTmp}"`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (existsSync(dumpBinTmp) && statSync(dumpBinTmp).size > 0) {
      if (existsSync(dumpBinFinal)) unlinkSync(dumpBinFinal);
      renameSync(dumpBinTmp, dumpBinFinal);
      const binSize = (statSync(dumpBinFinal).size / (1024 * 1024)).toFixed(2);
      console.log(`   ✓ Dump binário gerado com sucesso: transfer/bookchatbot_staging.dump (${binSize} MB)`);
      binSuccess = true;
    } else {
      throw new Error('Arquivo temporário de dump binário vazio ou não encontrado.');
    }
  } catch (dumpErr) {
    console.error(`   ⚠️ Erro ao gerar dump binário: ${dumpErr.message}`);
    if (existsSync(dumpBinTmp)) unlinkSync(dumpBinTmp);
    console.log('   Dump binário anterior preservado em transfer/bookchatbot_staging.dump');
  }

  // Dump SQL em texto
  try {
    execSync(
      `docker exec ${containerName} pg_dump -U bookchatbot -d bookchatbot_staging -f /tmp/staging_export.sql`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    execSync(
      `docker cp ${containerName}:/tmp/staging_export.sql "${dumpSqlTmp}"`,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (existsSync(dumpSqlTmp) && statSync(dumpSqlTmp).size > 0) {
      if (existsSync(dumpSqlFinal)) unlinkSync(dumpSqlFinal);
      renameSync(dumpSqlTmp, dumpSqlFinal);
      const sqlSize = (statSync(dumpSqlFinal).size / (1024 * 1024)).toFixed(2);
      console.log(`   ✓ Dump SQL gerado com sucesso: transfer/bookchatbot_staging.sql (${sqlSize} MB)`);
      sqlSuccess = true;
    } else {
      throw new Error('Arquivo temporário de dump SQL vazio ou não encontrado.');
    }
  } catch (sqlErr) {
    console.error(`   ⚠️ Erro ao gerar dump SQL: ${sqlErr.message}`);
    if (existsSync(dumpSqlTmp)) unlinkSync(dumpSqlTmp);
    console.log('   Dump SQL anterior preservado em transfer/bookchatbot_staging.sql');
  }

  // Limpeza temporária no container
  try {
    execSync(
      `docker exec ${containerName} rm -f /tmp/staging_export.dump /tmp/staging_export.sql`,
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
  } catch {
    // Ignora se não conseguir remover arquivos temporários do container
  }

  console.log('');
}

console.log('====================================================');
console.log('   RESUMO DA EXPORTAÇÃO                           ');
console.log('====================================================');
console.log(`Obras no banco:        ${booksCount}`);
console.log(`Embeddings totais:     ${totalEmbeddings}`);
console.log(`Arquivos em transfer/: ${transferDir}`);
console.log('Operação concluída sem qualquer alteração no banco de dados de origem.');
console.log('====================================================\n');

await pool.end();
