// Auth state do Baileys persistido no Supabase (tabela oct_wpp_sessao).
// Sobrevive a redeploy do Railway (disco efemero) -> nao precisa re-scan do QR.
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

export async function useSupabaseAuthState(sbUrl, sbKey, sessionId) {
  const base = `${sbUrl.replace(/\/$/, '')}/rest/v1/oct_wpp_sessao`;
  const headers = {
    apikey: sbKey,
    Authorization: `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  async function read(key) {
    const url = `${base}?session_id=eq.${encodeURIComponent(sessionId)}&key=eq.${encodeURIComponent(key)}&select=value`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const arr = await r.json();
    if (arr && arr[0] && arr[0].value != null) {
      // value ja vem como objeto JSON (jsonb); reidrata os Buffers
      return JSON.parse(JSON.stringify(arr[0].value), BufferJSON.reviver);
    }
    return null;
  }

  async function write(key, value) {
    const serial = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const body = [{ session_id: sessionId, key, value: serial, updated_at: new Date().toISOString() }];
    // upsert pela PK (session_id, key)
    await fetch(base, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body),
    });
  }

  async function remove(key) {
    const url = `${base}?session_id=eq.${encodeURIComponent(sessionId)}&key=eq.${encodeURIComponent(key)}`;
    await fetch(url, { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } });
  }

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => { await write('creds', creds); },
  };
}
