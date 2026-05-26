const backendUrlInput = document.getElementById('backendUrl');
const clientIdInput = document.getElementById('clientId');
const statusBox = document.getElementById('status');

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderStatus(state, message = '') {
  const connected = !!state?.state?.connected;
  const paired = !!state?.state?.paired;
  const authenticated = !!state?.state?.authenticated;

  statusBox.className = `status ${connected && paired ? 'ok' : 'bad'}`;
  statusBox.innerHTML = [
    message ? `<div>${message}</div>` : '',
    `<div>Backend: ${state?.backendUrl || '-'}</div>`,
    `<div>Client: ${state?.clientId || '-'}</div>`,
    `<div>Connecté: ${connected ? 'oui' : 'non'}</div>`,
    `<div>Authentifié: ${authenticated ? 'oui' : 'non'}</div>`,
    `<div>Pairé: ${paired ? 'oui' : 'non'}</div>`,
  ].filter(Boolean).join('');
}

async function refresh() {
  const state = await send({ type: 'GET_ENGINE_STATE' });
  if (state?.backendUrl) backendUrlInput.value = state.backendUrl;
  if (state?.clientId && !clientIdInput.value) clientIdInput.value = state.clientId;
  renderStatus(state);
}

document.getElementById('pair').addEventListener('click', async () => {
  const backendUrl = backendUrlInput.value.trim().replace(/\/$/, '');
  const clientId = clientIdInput.value.trim();

  const saved = await send({ type: 'SET_BACKEND_URL', backendUrl });
  if (!saved?.ok) {
    renderStatus({}, saved?.error || 'Backend URL invalide');
    return;
  }

  const result = await send({ type: 'PAIR_WITH_CLIENT', clientId });
  const state = await send({ type: 'GET_ENGINE_STATE' });
  renderStatus(state, result?.ok ? 'Pairing OK' : `Erreur: ${result?.error || 'pairing impossible'}`);
});

document.getElementById('disconnect').addEventListener('click', async () => {
  await send({ type: 'DISCONNECT_ENGINE' });
  await refresh();
});

document.getElementById('refresh').addEventListener('click', refresh);

refresh();
