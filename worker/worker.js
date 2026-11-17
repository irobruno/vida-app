// Vida IA — Cloudflare Worker
// Recebe texto do app e devolve itens organizados (captura) ou passos (quebrar tarefa).
// Usa o Workers AI (binding "AI"), sem chave de API. Não guarda nenhum dado.

const ALLOWED_ORIGINS = ['https://irobruno.github.io'];
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CATS = ['Comida', 'Mercado', 'Transporte', 'Casa', 'Lazer', 'Saúde', 'Outros'];

const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['gasto', 'entrada', 'compromisso', 'tarefa', 'ideia', 'gratidao', 'tarefa_projeto'] },
          texto: { type: 'string' },
          valor: { type: 'number' },
          categoria: { type: 'string', enum: CATS },
          data: { type: 'string' },
          hora: { type: 'string' },
          importante: { type: 'boolean' },
          projeto: { type: 'string' }
        },
        required: ['kind', 'texto']
      }
    }
  },
  required: ['items']
};

const BREAK_SCHEMA = {
  type: 'object',
  properties: { passos: { type: 'array', items: { type: 'string' } } },
  required: ['passos']
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) } });

function capturePrompt(b) {
  const projs = (b.projects || []).slice(0, 30).join(', ') || 'nenhum';
  return `Você organiza anotações rápidas de uma pessoa brasileira para um app pessoal. Hoje é ${b.today} (${b.weekday}).
Separe o texto em itens. Para cada item, escolha "kind":
- "gasto": dinheiro que saiu. "valor" em reais (número). "categoria" uma de: ${CATS.join(', ')}. "texto" = descrição curta (ex: "Mercado", "Uber").
- "entrada": dinheiro que entrou (salário, comissão, venda). "valor" e "texto".
- "compromisso": algo com dia/hora marcada (reunião, consulta, encontro). "data" YYYY-MM-DD, "hora" HH:MM (24h; se não disser, use "09:00"). "importante" true se a pessoa disser que é importante.
- "tarefa": algo a fazer sem horário. "data" YYYY-MM-DD (hoje se não disser).
- "ideia": ideias, coisas pra lembrar, perguntas, pensamentos soltos.
- "gratidao": algo pelo qual a pessoa é grata. "texto" sem o "sou grato por".
- "tarefa_projeto": tarefa claramente ligada a um destes projetos: ${projs}. "projeto" = nome exato do projeto.
Se a pessoa começar com "ideia:", "anotar:" ou "nota:", é "ideia".
Regras: "texto" curto, claro, em português, começando com maiúscula, sem datas/horas/valores dentro. Resolva datas relativas ("amanhã", "sexta", "dia 20") a partir de hoje. "mil" = x1000. Não invente itens.`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? cors(origin) : {} });
    if (!allowed) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'POST') return json({ error: 'method' }, 405, origin);

    let b;
    try { b = await request.json(); } catch { return json({ error: 'json' }, 400, origin); }
    const text = String(b.text || '').slice(0, 1500).trim();
    if (!text) return json({ error: 'empty' }, 400, origin);

    try {
      if (b.task === 'capture') {
        const r = await env.AI.run(MODEL, {
          messages: [{ role: 'system', content: capturePrompt(b) }, { role: 'user', content: text }],
          response_format: { type: 'json_schema', json_schema: CAPTURE_SCHEMA },
          max_tokens: 900, temperature: 0.1
        });
        const out = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
        return json({ items: Array.isArray(out?.items) ? out.items.slice(0, 15) : [] }, 200, origin);
      }
      if (b.task === 'break') {
        const r = await env.AI.run(MODEL, {
          messages: [
            { role: 'system', content: 'Você ajuda uma pessoa com TDAH a começar tarefas. Quebre a tarefa em 3 a 5 passos bem pequenos, concretos e fáceis de começar (o primeiro deve levar menos de 5 minutos). Português do Brasil, frases curtas no imperativo, sem numeração.' },
            { role: 'user', content: text }
          ],
          response_format: { type: 'json_schema', json_schema: BREAK_SCHEMA },
          max_tokens: 400, temperature: 0.3
        });
        const out = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
        return json({ passos: Array.isArray(out?.passos) ? out.passos.slice(0, 6) : [] }, 200, origin);
      }
      return json({ error: 'task' }, 400, origin);
    } catch (e) {
      return json({ error: 'ai', detail: String(e && e.message || e).slice(0, 200) }, 502, origin);
    }
  }
};
