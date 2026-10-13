const res = await fetch('http://127.0.0.1:11434/api/tags');
const j = await res.json();
console.log('Ollama models:', (j.models || []).map((m) => m.name).join(', ') || 'NENHUM');
