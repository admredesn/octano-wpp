// Auth state do Baileys persistido no Supabase (tabela oct_wpp_sessao).
// Sobrevive a redeploy do Railway (disco efemero) -> nao precisa re-scan do QR.
//
// 20/10/2026 — "Aguardando mensagem" de novo (09/10 e 20/10): a leitura e a gravacao das chaves eram "de melhor
// esforco". Uma LEITURA que falhava (Supabase lento, queda de rede) devolvia null = "nao existe sessao com esse
// contato" e o Baileys criava uma sessao NOVA por cima da que o celular do cliente conhece -> "Bad MAC" no gateway e
// "Aguardando mensagem" no cliente. A GRAVACAO nao conferia a resposta: perdida no meio de uma queda, a chave nova
// sumia. Agora:
//   - ler/gravar com retentativa; erro que sobra SOBE (o Baileys refaz a transacao, 10x de 3 s) em vez de virar null;
//   - chaves lidas em lote (1 consulta) e gravadas em lote (1 upsert + 1 delete por transacao do Baileys);
//   - creds gravadas em fila (a ordem das gravacoes e' a ordem das mudancas).
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const LOTE = 60;   // chaves por consulta (a URL do PostgREST tem limite de tamanho)

export async function useSupabaseAuthState(sbUrl, sbKey, sessionId, aviso = () => {}) {
  const base = `${sbUrl.replace(/\/$/, '')}/rest/v1/oct_wpp_sessao`;
  const sid = encodeURIComponent(sessionId);
  const headers = {
    apikey: sbKey,
    Authorization: `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };
  const emLista = (keys) => keys.map((k) => encodeURIComponent(`"${k}"`)).join(',');

  async function pedir(url, opts, oque) {
    let ultimo = null;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
        if (r.ok) return r;
        ultimo = new Error(`${oque}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break;   // 4xx nao melhora repetindo
      } catch (e) { ultimo = e; }
      await esperar(400 * Math.pow(2, i));
    }
    aviso(`supabase falhou (${oque}): ${ultimo && ultimo.message}`);
    throw ultimo || new Error(oque);
  }

  const reidratar = (valor) => JSON.parse(JSON.stringify(valor), BufferJSON.reviver);
  const serializar = (valor) => JSON.parse(JSON.stringify(valor, BufferJSON.replacer));

  async function lerVarias(keys) {
    const out = {};
    for (let i = 0; i < keys.length; i += LOTE) {
      const parte = keys.slice(i, i + LOTE);
      const r = await pedir(`${base}?session_id=eq.${sid}&key=in.(${emLista(parte)})&select=key,value`, { headers }, 'ler chaves');
      for (const row of await r.json()) if (row && row.value != null) out[row.key] = reidratar(row.value);
    }
    return out;
  }

  async function gravarVarias(linhas) {   // [{key, value}]
    const agora = new Date().toISOString();
    for (let i = 0; i < linhas.length; i += 200) {
      const corpo = linhas.slice(i, i + 200).map((l) => ({ session_id: sessionId, key: l.key, value: serializar(l.value), updated_at: agora }));
      await pedir(base, {   // upsert pela PK (session_id, key)
        method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(corpo),
      }, 'gravar chaves');
    }
  }

  async function apagarVarias(keys) {
    for (let i = 0; i < keys.length; i += LOTE) {
      await pedir(`${base}?session_id=eq.${sid}&key=in.(${emLista(keys.slice(i, i + LOTE))})`,
        { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } }, 'apagar chaves');
    }
  }

  // creds: na partida o erro sobe (melhor nao subir do que subir com credencial nova e perder o numero)
  const salvas = await lerVarias(['creds']);
  const creds = salvas.creds || initAuthCreds();

  let filaCreds = Promise.resolve();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const achou = await lerVarias(ids.map((id) => `${type}-${id}`));
          const data = {};
          for (const id of ids) {
            let value = achou[`${type}-${id}`];
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value === undefined ? null : value;
          }
          return data;
        },
        set: async (data) => {
          const gravar = []; const apagar = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) gravar.push({ key, value }); else apagar.push(key);
            }
          }
          if (gravar.length) await gravarVarias(gravar);
          if (apagar.length) await apagarVarias(apagar);
        },
      },
    },
    // em fila: duas atualizacoes seguidas nao podem chegar fora de ordem ao banco. O erro fica no aviso (o evento
    // creds.update do Baileys nao espera a promessa; uma rejeicao solta derrubaria o processo).
    saveCreds: () => (filaCreds = filaCreds
      .then(() => gravarVarias([{ key: 'creds', value: creds }]))
      .catch((e) => aviso('creds nao gravadas: ' + (e && e.message)))),
  };
}
