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
  statusBox.textContent = [
    message,
    `Backend: ${state?.backendUrl || '-'}`,
    `Client: ${state?.clientId || '-'}`,
    `Connecte: ${connected ? 'oui' : 'non'}`,
    `Authentifie: ${authenticated ? 'oui' : 'non'}`,
    `Paire: ${paired ? 'oui' : 'non'}`,
  ].filter(Boolean).join('\n');
}

function renderError(message) {
  statusBox.className = 'status bad';
  statusBox.textContent = message;
}

async function refresh() {
  try {
    const state = await send({ type: 'GET_ENGINE_STATE' });
    if (state?.backendUrl) backendUrlInput.value = state.backendUrl;
    if (state?.state?.paired && state?.clientId && !clientIdInput.value) {
      clientIdInput.value = state.clientId;
    }
    renderStatus(state);
  } catch (error) {
    renderError(`Background extension indisponible: ${error?.message || error}`);
  }
}

document.getElementById('pair').addEventListener('click', async () => {
  const backendUrl = backendUrlInput.value.trim().replace(/\/$/, '');
  const clientId = clientIdInput.value.trim();

  if (!backendUrl) {
    renderError('Backend URL obligatoire');
    return;
  }

  if (!clientId) {
    renderError("Client ID obligatoire. Copie le client_id affiche dans l'application.");
    return;
  }

  renderError('Connexion en cours...');

  try {
    const saved = await send({ type: 'SET_BACKEND_URL', backendUrl });
    if (!saved?.ok) {
      renderError(saved?.error || 'Backend URL invalide');
      return;
    }

    const result = await send({ type: 'PAIR_WITH_CLIENT', clientId });
    const state = await send({ type: 'GET_ENGINE_STATE' });
    renderStatus(
      state,
      result?.ok
        ? 'Pairing OK'
        : `Erreur: ${result?.error || 'pairing impossible'}. Verifie que tu as copie le client_id depuis l'application Render.`
    );
  } catch (error) {
    renderError(`Erreur extension: ${error?.message || error}`);
  }
});

document.getElementById('disconnect').addEventListener('click', async () => {
  try {
    await send({ type: 'DISCONNECT_ENGINE' });
    await refresh();
  } catch (error) {
    renderError(`Erreur deconnexion: ${error?.message || error}`);
  }
});

document.getElementById('refresh').addEventListener('click', refresh);

refresh();
