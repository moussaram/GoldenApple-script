// background.js - Service Worker central
// Pont entre le content script (moteur) et le backend Node.js

importScripts(
  'communication/websocket.js',
  'communication/auth.js',
  'communication/pairing.js',
  'communication/sync.js'
);

const ENGINE = {
  clientId: null,
  sessionToken: null,
  deviceId: null,
  config: {
    backendUrl: 'http://localhost:3000',
    restUrl: 'http://localhost:3000',
    reconnectInterval: 3000,
    maxReconnectAttempts: 20,
    heartbeatInterval: 15000
  },
  state: {
    connected: false,
    authenticated: false,
    paired: false,
    analyzing: false,
    currentTabId: null,
    currentPlatform: null
  },
  metrics: {
    sessionsAnalyzed: 0,
    cellsDetected: 0,
    predictionsSent: 0,
    lastPrediction: null
  },
  ws: null,
  reconnectAttempts: 0,
  heartbeatTimer: null,
  outboundQueue: []
};

// ==========================================
// INITIALISATION
// ==========================================

async function init() {
  console.log('[Engine BG] Initialisation...');

  // Charger l'identité persistante
  const stored = await chrome.storage.local.get(['clientId', 'sessionToken', 'deviceId', 'pairedDevice', 'backendUrl']);
  
  ENGINE.clientId = stored.clientId || generateClientId();
  ENGINE.deviceId = stored.deviceId || generateDeviceId();
  if (stored.backendUrl) {
    setBackendUrl(stored.backendUrl);
  }
  
  if (stored.sessionToken) {
    ENGINE.sessionToken = stored.sessionToken;
  }

  // Sauvegarder l'identité
  await chrome.storage.local.set({
    deviceId: ENGINE.deviceId
  });

  // Connexion au backend seulement si le pairing a déjà fourni un token extension
  if (ENGINE.sessionToken && ENGINE.clientId) {
    connectWebSocket();
  } else {
    console.log('[Engine BG] En attente de pairing avec un client_id app');
  }

  // Écouter les messages du content script
  chrome.runtime.onMessage.addListener(handleContentMessage);

  // Écouter les changements de tabs
  chrome.tabs.onActivated.addListener(handleTabChange);
  chrome.tabs.onUpdated.addListener(handleTabUpdate);

  console.log(`[Engine BG] ✓ Initialisé | clientId: ${ENGINE.clientId.substring(0, 8)}...`);
}

// ==========================================
// WEBSOCKET - Communication Backend
// ==========================================

function connectWebSocket() {
  if (ENGINE.ws && ENGINE.ws.readyState === WebSocket.OPEN) return;
  if (!ENGINE.sessionToken) {
    console.warn('[Engine BG] Connexion impossible: token extension manquant');
    return;
  }

  try {
    ENGINE.ws = new WebSocket(toSocketIoUrl(ENGINE.config.backendUrl));

    ENGINE.ws.onopen = () => {
      console.log('[Engine BG] WebSocket connecté');

      // S'authentifier immédiatement
      // Socket.IO auth is sent after the Engine.IO open packet.
      
      // Démarrer le heartbeat
    };

    ENGINE.ws.onmessage = (event) => {
      handleSocketIoPacket(event.data);
    };

    ENGINE.ws.onclose = (event) => {
      console.log(`[Engine BG] WebSocket fermé (code: ${event.code})`);
      ENGINE.state.connected = false;
      ENGINE.state.authenticated = false;
      stopHeartbeat();
      scheduleReconnect();
    };

    ENGINE.ws.onerror = (error) => {
      console.error('[Engine BG] Erreur WebSocket:', error);
    };

  } catch (e) {
    console.error('[Engine BG] Échec connexion WebSocket:', e);
    scheduleReconnect();
  }
}

function toSocketIoUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/socket.io/';
  url.search = 'EIO=4&transport=websocket';
  return url.toString();
}

function handleSocketIoPacket(raw) {
  if (typeof raw !== 'string') return;

  if (raw === '2') {
    ENGINE.ws?.send('3');
    return;
  }

  if (raw.startsWith('0')) {
    authenticate();
    return;
  }

  if (raw.startsWith('40')) {
    ENGINE.state.connected = true;
    ENGINE.state.authenticated = true;
    ENGINE.state.paired = true;
    ENGINE.reconnectAttempts = 0;
    startHeartbeat();
    console.log('[Engine BG] Socket.IO authentifie');
    flushOutboundQueue();
    sendToBackend({
      type: 'status_report',
      engine: {
        state: ENGINE.state,
        metrics: ENGINE.metrics,
        config: ENGINE.config
      }
    });
    return;
  }

  if (raw.startsWith('44')) {
    console.error('[Engine BG] Auth Socket.IO refusee:', raw.substring(2));
    ENGINE.state.authenticated = false;
    return;
  }

  if (raw.startsWith('42')) {
    try {
      const packet = JSON.parse(raw.substring(2));
      const [event, payload] = packet;
      handleBackendEvent(event, payload);
    } catch (e) {
      console.warn('[Engine BG] Paquet Socket.IO invalide:', e);
    }
  }
}

function socketEmit(event, payload) {
  if (ENGINE.ws?.readyState !== WebSocket.OPEN || !ENGINE.state.authenticated) {
    return false;
  }
  ENGINE.ws.send(`42${JSON.stringify([event, payload])}`);
  return true;
}

function enqueueBackendMessage(event, payload) {
  if (event === 'heartbeat') return false;

  ENGINE.outboundQueue.push({ event, payload });
  if (ENGINE.outboundQueue.length > 100) {
    ENGINE.outboundQueue.splice(0, ENGINE.outboundQueue.length - 100);
  }
  return true;
}

function flushOutboundQueue() {
  if (!ENGINE.outboundQueue.length) return;

  const pending = ENGINE.outboundQueue.splice(0);
  for (const item of pending) {
    if (!socketEmit(item.event, item.payload)) {
      ENGINE.outboundQueue.unshift(item);
      break;
    }
  }
}

function scheduleReconnect() {
  if (ENGINE.reconnectAttempts >= ENGINE.config.maxReconnectAttempts) {
    console.error('[Engine BG] Maximum de tentatives de reconnexion atteint');
    return;
  }

  ENGINE.reconnectAttempts++;
  const delay = ENGINE.config.reconnectInterval * Math.min(ENGINE.reconnectAttempts, 5);
  
  console.log(`[Engine BG] Reconnexion dans ${delay}ms (tentative ${ENGINE.reconnectAttempts})`);
  setTimeout(connectWebSocket, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  ENGINE.heartbeatTimer = setInterval(() => {
    if (ENGINE.ws?.readyState === WebSocket.OPEN) {
      socketEmit('heartbeat', {
        timestamp: Date.now(),
        clientId: ENGINE.clientId
      });
    }
  }, ENGINE.config.heartbeatInterval);
}

function stopHeartbeat() {
  if (ENGINE.heartbeatTimer) {
    clearInterval(ENGINE.heartbeatTimer);
    ENGINE.heartbeatTimer = null;
  }
}

// ==========================================
// AUTHENTIFICATION
// ==========================================

function authenticate() {
  ENGINE.ws?.send(`40${JSON.stringify({ token: ENGINE.sessionToken })}`);
}

function generateClientId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

function generateDeviceId() {
  const nav = navigator.userAgent || 'unknown';
  const hash = Array.from(nav).reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xFFFFFFFF, 0);
  return `ext-${hash.toString(16)}-${Date.now().toString(36)}`;
}

// ==========================================
// GESTION DES MESSAGES BACKEND
// ==========================================

function handleBackendEvent(event, payload) {
  switch (event) {
    case 'command':
    case 'extension:command':
      handleBackendCommand(payload?.action, payload?.payload || payload);
      break;

    case 'config_update':
      if (payload?.config) {
        Object.assign(ENGINE.config, payload.config);
        console.log('[Engine BG] Configuration mise a jour');
      }
      break;

    case 'heartbeat_ack':
      break;

    default:
      console.log('[Engine BG] Event backend non gere:', event);
  }
}

function handleBackendMessage(message) {
  switch (message.type) {
    case 'auth_success':
      ENGINE.sessionToken = message.sessionToken;
      ENGINE.state.authenticated = true;
      chrome.storage.local.set({ sessionToken: message.sessionToken });
      console.log('[Engine BG] ✓ Authentifié');
      break;

    case 'auth_error':
      console.error('[Engine BG] Erreur auth:', message.reason);
      break;

    case 'pair_request':
      handlePairRequest(message);
      break;

    case 'pair_success':
      ENGINE.state.paired = true;
      chrome.storage.local.set({ pairedDevice: message.deviceInfo });
      console.log('[Engine BG] ✓ Appairé avec:', message.deviceInfo.deviceName);
      break;

    case 'command':
      handleBackendCommand(message.command, message.params);
      break;

    case 'config_update':
      if (message.config) {
        Object.assign(ENGINE.config, message.config);
        console.log('[Engine BG] Configuration mise à jour');
      }
      break;

    case 'pong':
      // Heartbeat response
      break;

    default:
      console.log('[Engine BG] Message non géré:', message.type);
  }
}

function handlePairRequest(message) {
  // Vérifier le code d'appairage
  if (message.code) {
    // Stocker temporairement pour validation
    chrome.storage.session.set({
      pendingPairCode: message.code,
      pendingPairExpiry: Date.now() + 60000
    });

    // Notifier le content script pour affichage si popup ouvert
    chrome.runtime.sendMessage({
      type: 'PAIR_CODE',
      code: message.code,
      expiresIn: 60
    });
  }
}

function handleBackendCommand(command, params) {
  switch (command) {
    case 'script:start':
    case 'start_analysis':
      ENGINE.state.analyzing = true;
      notifyContentScript({ type: 'ENGINE_COMMAND', command: 'START_ANALYSIS', params });
      break;

    case 'script:stop':
    case 'stop_analysis':
      ENGINE.state.analyzing = false;
      notifyContentScript({ type: 'ENGINE_COMMAND', command: 'STOP_ANALYSIS' });
      break;

    case 'reconnect':
      if (ENGINE.ws) {
        ENGINE.ws.close(1000, 'Manual reconnect');
      }
      connectWebSocket();
      break;

    case 'get_status':
      sendToBackend({
        type: 'status_report',
        engine: {
          state: ENGINE.state,
          metrics: ENGINE.metrics,
          config: ENGINE.config
        },
        timestamp: Date.now()
      });
      break;

    case 'reset_metrics':
      ENGINE.metrics = {
        sessionsAnalyzed: 0,
        cellsDetected: 0,
        predictionsSent: 0,
        lastPrediction: null
      };
      break;

    case 'update_config':
      if (params) Object.assign(ENGINE.config, params);
      break;
  }
}

// ==========================================
// GESTION DES MESSAGES CONTENT SCRIPT
// ==========================================

function handleContentMessage(message, sender, sendResponse) {
  switch (message.type) {
    // Résultats d'analyse du jeu
    case 'ANALYSIS_RESULT':
      handleAnalysisResult(message.payload, sender.tab);
      sendResponse({ received: true });
      break;

    // Détection de cellules
    case 'CELLS_DETECTED':
      handleCellsDetected(message.payload, sender.tab);
      sendResponse({ received: true });
      break;

    // Prédictions
    case 'PREDICTION_READY':
      handlePredictionReady(message.payload, sender.tab);
      sendResponse({ received: true });
      break;

    // État du content script
    case 'ENGINE_STATUS':
      sendResponse({
        clientId: ENGINE.clientId,
        backendUrl: ENGINE.config.backendUrl,
        connected: ENGINE.state.connected,
        authenticated: ENGINE.state.authenticated,
        paired: ENGINE.state.paired,
        analyzing: ENGINE.state.analyzing
      });
      break;

    case 'GET_ENGINE_STATE':
      sendResponse({
        ok: true,
        clientId: ENGINE.clientId,
        deviceId: ENGINE.deviceId,
        backendUrl: ENGINE.config.backendUrl,
        state: ENGINE.state,
        metrics: ENGINE.metrics
      });
      break;

    case 'SET_BACKEND_URL':
      if (message.backendUrl) {
        setBackendUrl(message.backendUrl);
        chrome.storage.local.set({ backendUrl: ENGINE.config.backendUrl });
        sendResponse({ ok: true, backendUrl: ENGINE.config.backendUrl });
      } else {
        sendResponse({ ok: false, error: 'backendUrl manquant' });
      }
      break;

    case 'PAIR_WITH_CLIENT':
      if (message.clientId) {
        pairExtension(message.clientId)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      sendResponse({ ok: false, error: 'client_id manquant' });
      break;

    case 'DISCONNECT_ENGINE':
      if (ENGINE.ws) {
        ENGINE.ws.close(1000, 'User disconnect');
      }
      ENGINE.state.connected = false;
      ENGINE.state.authenticated = false;
      sendResponse({ ok: true });
      break;

    case 'RESET_PAIRING':
      ENGINE.sessionToken = null;
      ENGINE.state.connected = false;
      ENGINE.state.authenticated = false;
      ENGINE.state.paired = false;
      if (ENGINE.ws) ENGINE.ws.close(1000, 'Reset pairing');
      chrome.storage.local.remove(['clientId', 'sessionToken', 'pairedDevice']);
      sendResponse({ ok: true });
      break;

    // Code d'appairage
    case 'GET_PAIR_CODE':
      chrome.storage.session.get('pendingPairCode', (data) => {
        sendResponse({ 
          code: data.pendingPairCode || null,
          expiresIn: data.pendingPairExpiry ? Math.max(0, Math.floor((data.pendingPairExpiry - Date.now()) / 1000)) : 0
        });
      });
      return true; // keep channel open

    // Confirmation appairage
    case 'CONFIRM_PAIR':
      if (message.code) {
        pairExtension(message.code)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      break;

    case 'LOG':
      if (message.level && message.message) {
        const logFn = console[message.level] || console.log;
        logFn(`[Content] ${message.message}`);
      }
      break;
  }

  return true;
}

// ==========================================
// TRAITEMENT DES DONNÉES DU JEU
// ==========================================

function handleAnalysisResult(payload, tab) {
  if (!payload) return;

  ENGINE.metrics.sessionsAnalyzed++;

  // Enrichir avec metadata
  const enriched = {
    ...payload,
    clientId: ENGINE.clientId,
    deviceId: ENGINE.deviceId,
    tabId: tab?.id,
    platform: detectPlatform(tab?.url),
    timestamp: Date.now()
  };

  // Envoyer au backend
  sendToBackend({
    type: 'analysis_result',
    payload: enriched
  });

  // Stocker localement pour backup
  cacheResult(enriched);
}

function handleCellsDetected(payload, tab) {
  if (!payload) return;

  ENGINE.metrics.cellsDetected += payload.appleCells?.length || 0;
  ENGINE.metrics.cellsDetected += payload.bittenCells?.length || 0;

  const enriched = {
    ...payload,
    clientId: ENGINE.clientId,
    deviceId: ENGINE.deviceId,
    tabId: tab?.id,
    platform: detectPlatform(tab?.url),
    timestamp: Date.now()
  };

  // Envoi immédiat pour les cellules (temps réel)
  sendToBackend({
    type: 'cells_detected',
    payload: enriched
  });
}

function handlePredictionReady(payload, tab) {
  if (!payload) return;

  ENGINE.metrics.predictionsSent++;
  ENGINE.metrics.lastPrediction = payload;

  const enriched = {
    ...payload,
    clientId: ENGINE.clientId,
    deviceId: ENGINE.deviceId,
    tabId: tab?.id,
    platform: detectPlatform(tab?.url),
    timestamp: Date.now()
  };

  sendToBackend({
    type: 'prediction',
    payload: enriched
  });
}

// ==========================================
// UTILITAIRES
// ==========================================

function detectPlatform(url) {
  if (!url) return 'unknown';
  const domain = new URL(url).hostname;
  
  if (domain.includes('1xbet')) return '1xbet';
  if (domain.includes('melbet')) return 'melbet';
  if (domain.includes('winwin') || domain === 'winwin-17094.pro') return 'winwin';
  if (domain.includes('megapari')) return 'megapari';
  if (domain.includes('1xgame')) return '1xgame';
  if (domain.includes('1xslot')) return '1xslot';
  
  return 'other';
}

function sendToBackend(data) {
  if (!data || !data.type) return false;

  const timestamped = {
    ...data,
    clientId: ENGINE.clientId,
    deviceId: ENGINE.deviceId,
    timestamp: data.timestamp || Date.now()
  };

  switch (data.type) {
    case 'analysis_result':
    case 'cells_detected':
    case 'prediction':
    case 'status_report':
      return socketEmit(data.type, timestamped) || enqueueBackendMessage(data.type, timestamped);
    case 'heartbeat':
      return socketEmit('heartbeat', timestamped);
    default:
      return socketEmit('extension:update', timestamped) || enqueueBackendMessage('extension:update', timestamped);
  }
}

function setBackendUrl(rawUrl) {
  const normalized = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!normalized) return;

  ENGINE.config.backendUrl = normalized;
  ENGINE.config.restUrl = normalized;
}

async function pairExtension(clientId) {
  const normalizedClientId = String(clientId).trim();
  if (!normalizedClientId) {
    throw new Error('client_id manquant');
  }

  const response = await fetch(`${ENGINE.config.restUrl}/api/pairing/extension`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: normalizedClientId,
      deviceId: ENGINE.deviceId,
      deviceName: 'Extension Browser'
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Pairing failed');
  }

  ENGINE.clientId = data.clientId;
  ENGINE.sessionToken = data.token;
  ENGINE.state.paired = true;

  await chrome.storage.local.set({
    clientId: ENGINE.clientId,
    sessionToken: ENGINE.sessionToken,
    pairedDevice: data.device
  });

  connectWebSocket();
  return { ok: true, clientId: ENGINE.clientId, device: data.device };
}

function notifyContentScript(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

function cacheResult(data) {
  chrome.storage.local.get(['resultCache'], (result) => {
    const cache = result.resultCache || [];
    cache.push(data);
    // Garder les 100 derniers
    if (cache.length > 100) cache.splice(0, cache.length - 100);
    chrome.storage.local.set({ resultCache: cache });
  });
}

// ==========================================
// GESTION DES TABS
// ==========================================

function handleTabChange(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab?.url && isGamePage(tab.url)) {
      ENGINE.state.currentTabId = tab.id;
      ENGINE.state.currentPlatform = detectPlatform(tab.url);
      
      notifyContentScript({
        type: 'TAB_CHANGED',
        tabId: tab.id,
        platform: ENGINE.state.currentPlatform
      });
    }
  });
}

function handleTabUpdate(tabId, changeInfo, tab) {
  if (changeInfo.url && isGamePage(changeInfo.url)) {
    ENGINE.state.currentTabId = tabId;
    ENGINE.state.currentPlatform = detectPlatform(changeInfo.url);
  }
}

function isGamePage(url) {
  if (!url) return false;
  const patterns = ['apple', 'apple-of-fortune', 'fortune', 'game', '1xgame'];
  return patterns.some(p => url.toLowerCase().includes(p));
}

// ==========================================
// DÉMARRAGE
// ==========================================

init();
