// communication/websocket.js - Gestionnaire WebSocket temps réel
// Communication bidirectionnelle entre l'extension et le backend Node.js
// Support: heartbeat, reconnexion, files d'attente, compression

class EngineWebSocket {
    constructor(config = {}) {
        this.config = {
            url: config.url || 'wss://api.apple-engine.com/ws',
            reconnectInterval: config.reconnectInterval || 3000,
            maxReconnectAttempts: config.maxReconnectAttempts || 20,
            heartbeatInterval: config.heartbeatInterval || 15000,
            heartbeatTimeout: config.heartbeatTimeout || 5000,
            maxQueueSize: config.maxQueueSize || 100,
            compression: config.compression !== false,
            ...config
        };

        // État
        this.ws = null;
        this.state = {
            connected: false,
            authenticated: false,
            paired: false,
            lastHeartbeat: null,
            reconnectAttempts: 0,
            intentionalClose: false
        };

        // Files d'attente
        this.sendQueue = [];
        this.pendingAcks = new Map();
        this.messageBuffer = [];

        // Timers
        this.heartbeatTimer = null;
        this.heartbeatTimeoutTimer = null;
        this.reconnectTimer = null;

        // Callbacks
        this.onOpen = null;
        this.onClose = null;
        this.onError = null;
        this.onMessage = null;
        this.onAuthenticated = null;
        this.onPaired = null;
        this.onReconnect = null;

        // Métriques
        this.metrics = {
            messagesSent: 0,
            messagesReceived: 0,
            bytesSent: 0,
            bytesReceived: 0,
            reconnects: 0,
            errors: 0,
            uptime: 0,
            startTime: null
        };

        // ID de corrélation
        this.correlationId = 0;
        this.pendingCorrelations = new Map();

        console.log('[WS] Initialisé | URL:', this.config.url);
    }

    // ==========================================
    // CONNEXION
    // ==========================================

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            console.log('[WS] Déjà connecté ou en cours de connexion');
            return;
        }

        this.state.intentionalClose = false;
        this.state.reconnectAttempts = 0;

        try {
            console.log('[WS] Connexion à', this.config.url);
            
            this.ws = new WebSocket(this.config.url);

            // Timeout de connexion
            const connectionTimeout = setTimeout(() => {
                if (this.ws?.readyState === WebSocket.CONNECTING) {
                    console.warn('[WS] Timeout de connexion');
                    this.ws.close();
                }
            }, 10000);

            this.ws.onopen = () => {
                clearTimeout(connectionTimeout);
                this.handleOpen();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event);
            };

            this.ws.onclose = (event) => {
                clearTimeout(connectionTimeout);
                this.handleClose(event);
            };

            this.ws.onerror = (error) => {
                clearTimeout(connectionTimeout);
                this.handleError(error);
            };

        } catch (e) {
            console.error('[WS] Erreur de création WebSocket:', e);
            this.scheduleReconnect();
        }
    }

    disconnect() {
        this.state.intentionalClose = true;
        this.stopHeartbeat();
        this.clearTimers();

        if (this.ws) {
            // Envoyer un message de déconnexion propre
            this.sendRaw({
                type: 'disconnect',
                clientId: this.clientId,
                timestamp: Date.now(),
                reason: 'client_disconnect'
            });

            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }

        this.state.connected = false;
        this.state.authenticated = false;
        this.state.paired = false;

        // Vider les files
        this.sendQueue = [];
        this.pendingAcks.clear();
        this.pendingCorrelations.clear();

        console.log('[WS] Déconnecté');
    }

    // ==========================================
    // GESTION DES ÉVÉNEMENTS
    // ==========================================

    handleOpen() {
        console.log('[WS] ✓ Connecté');
        
        this.state.connected = true;
        this.state.reconnectAttempts = 0;
        this.metrics.startTime = Date.now();
        this.metrics.uptime = 0;

        // Démarrer le heartbeat
        this.startHeartbeat();

        // Vider la file d'attente
        this.flushQueue();

        // Callback
        if (this.onOpen) this.onOpen();

        // Émettre un événement
        this.emit('connected', { timestamp: Date.now() });
    }

    handleMessage(event) {
        try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            
            this.metrics.messagesReceived++;
            this.metrics.bytesReceived += event.data.length || 0;

            // Traiter les messages système
            if (this.handleSystemMessage(data)) return;

            // Callback générique
            if (this.onMessage) this.onMessage(data);

            // Corrélation
            if (data.correlationId) {
                const correlation = this.pendingCorrelations.get(data.correlationId);
                if (correlation) {
                    clearTimeout(correlation.timeout);
                    correlation.resolve(data);
                    this.pendingCorrelations.delete(data.correlationId);
                }
            }

            // Émettre l'événement
            this.emit('message', data);

        } catch (e) {
            console.error('[WS] Erreur parsing message:', e);
            this.metrics.errors++;
        }
    }

    handleClose(event) {
        console.log(`[WS] Fermé (code: ${event.code}, raison: ${event.reason || 'N/A'})`);
        
        this.state.connected = false;
        this.state.authenticated = false;
        this.state.paired = false;
        
        this.stopHeartbeat();
        this.ws = null;

        // Métriques
        if (this.metrics.startTime) {
            this.metrics.uptime = Date.now() - this.metrics.startTime;
        }

        // Callback
        if (this.onClose) this.onClose(event);

        // Reconnexion
        if (!this.state.intentionalClose) {
            this.scheduleReconnect();
        }
    }

    handleError(error) {
        console.error('[WS] Erreur:', error.message || error);
        this.metrics.errors++;
        
        if (this.onError) this.onError(error);
    }

    // ==========================================
    // MESSAGES SYSTÈME
    // ==========================================

    handleSystemMessage(data) {
        switch (data.type) {
            case 'auth_success':
                this.state.authenticated = true;
                this.clientId = data.clientId;
                this.sessionToken = data.sessionToken;
                console.log('[WS] ✓ Authentifié | clientId:', data.clientId?.substring(0, 8));
                if (this.onAuthenticated) this.onAuthenticated(data);
                return true;

            case 'auth_error':
                console.error('[WS] Erreur auth:', data.reason);
                this.state.authenticated = false;
                if (this.onError) this.onError(new Error(`Auth error: ${data.reason}`));
                return true;

            case 'pair_success':
                this.state.paired = true;
                this.pairedDevice = data.deviceInfo;
                console.log('[WS] ✓ Appairé avec:', data.deviceInfo?.deviceName);
                if (this.onPaired) this.onPaired(data);
                return true;

            case 'pair_error':
                console.error('[WS] Erreur appairage:', data.reason);
                this.state.paired = false;
                return true;

            case 'pong':
                this.state.lastHeartbeat = Date.now();
                if (this.heartbeatTimeoutTimer) {
                    clearTimeout(this.heartbeatTimeoutTimer);
                    this.heartbeatTimeoutTimer = null;
                }
                return true;

            case 'server_shutdown':
                console.warn('[WS] Arrêt serveur programmé');
                this.state.intentionalClose = true;
                this.disconnect();
                return true;

            case 'error':
                console.error('[WS] Erreur serveur:', data.message);
                this.metrics.errors++;
                return true;

            case 'ack':
                // Acquittement d'un message envoyé
                if (data.ackId) {
                    this.pendingAcks.delete(data.ackId);
                }
                return true;
        }

        return false;
    }

    // ==========================================
    // ENVOI DE MESSAGES
    // ==========================================

    send(type, payload = {}, options = {}) {
        const message = {
            type,
            ...payload,
            timestamp: options.timestamp ?? Date.now(),
            clientId: this.clientId,
            correlationId: options.correlationId || this.generateCorrelationId(),
            requireAck: options.requireAck ?? false,
            priority: options.priority || 'normal'
        };

        // Si besoin d'acquittement
        if (message.requireAck) {
            message.ackId = this.generateAckId();
            
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingAcks.delete(message.ackId);
                    reject(new Error(`Timeout waiting for ack: ${message.ackId}`));
                }, options.ackTimeout || 10000);

                this.pendingAcks.set(message.ackId, { resolve, reject, timeout, timestamp: Date.now() });
                this.enqueue(message);
            });
        }

        // Promesse de corrélation
        if (options.waitForCorrelation) {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingCorrelations.delete(message.correlationId);
                    reject(new Error(`Timeout waiting for correlation: ${message.correlationId}`));
                }, options.correlationTimeout || 15000);

                this.pendingCorrelations.set(message.correlationId, { resolve, reject, timeout });
                this.enqueue(message);
            });
        }

        this.enqueue(message);
        return Promise.resolve({ sent: true, correlationId: message.correlationId });
    }

    enqueue(message) {
        if (this.state.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.sendRaw(message);
        } else {
            // Mettre en file d'attente
            if (this.sendQueue.length < this.config.maxQueueSize) {
                this.sendQueue.push(message);
                console.log(`[WS] Message mis en file (${this.sendQueue.length} en attente)`);
            } else {
                console.warn('[WS] File d\'attente pleine, message ignoré');
            }
        }
    }

    sendRaw(message) {
        try {
            const data = JSON.stringify(message);
            this.ws.send(data);
            
            this.metrics.messagesSent++;
            this.metrics.bytesSent += data.length;

            return true;
        } catch (e) {
            console.error('[WS] Erreur envoi:', e);
            this.metrics.errors++;
            return false;
        }
    }

    flushQueue() {
        if (this.sendQueue.length === 0) return;

        console.log(`[WS] Vidage de la file (${this.sendQueue.length} messages)`);
        
        while (this.sendQueue.length > 0) {
            const message = this.sendQueue.shift();
            this.sendRaw(message);
        }
    }

    // ==========================================
    // HEARTBEAT
    // ==========================================

    startHeartbeat() {
        this.stopHeartbeat();

        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.sendRaw({
                    type: 'ping',
                    timestamp: Date.now(),
                    clientId: this.clientId
                });

                // Timeout si pas de pong
                this.heartbeatTimeoutTimer = setTimeout(() => {
                    console.warn('[WS] Heartbeat timeout - reconnexion');
                    this.metrics.errors++;
                    if (this.ws) {
                        this.ws.close(4001, 'Heartbeat timeout');
                    }
                }, this.config.heartbeatTimeout);
            }
        }, this.config.heartbeatInterval);

        console.log(`[WS] Heartbeat démarré (intervalle: ${this.config.heartbeatInterval}ms)`);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
    }

    // ==========================================
    // RECONNEXION
    // ==========================================

    scheduleReconnect() {
        if (this.state.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error(`[WS] Maximum de tentatives atteint (${this.config.maxReconnectAttempts})`);
            if (this.onError) {
                this.onError(new Error('Max reconnection attempts reached'));
            }
            return;
        }

        // Backoff exponentiel avec jitter
        const baseDelay = this.config.reconnectInterval;
        const exponentialDelay = baseDelay * Math.pow(1.5, this.state.reconnectAttempts);
        const jitter = Math.random() * 1000;
        const delay = Math.min(exponentialDelay + jitter, 30000);

        this.state.reconnectAttempts++;
        this.metrics.reconnects++;

        console.log(`[WS] Reconnexion dans ${Math.round(delay)}ms (tentative ${this.state.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

        if (this.onReconnect) {
            this.onReconnect({
                attempt: this.state.reconnectAttempts,
                maxAttempts: this.config.maxReconnectAttempts,
                delay
            });
        }

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    // ==========================================
    // MÉTHODES DE COMMUNICATION SPÉCIFIQUES
    // ==========================================

    // Envoyer un résultat d'analyse
    sendAnalysis(analysisData) {
        return this.send('analysis_result', {
            payload: analysisData
        }, {
            priority: 'high',
            requireAck: true,
            ackTimeout: 5000
        });
    }

    // Envoyer une détection de cellules
    sendCellsDetected(cellsData) {
        return this.send('cells_detected', {
            payload: cellsData
        }, {
            priority: 'high',
            requireAck: false
        });
    }

    // Envoyer une prédiction
    sendPrediction(predictionData) {
        return this.send('prediction', {
            payload: predictionData
        }, {
            priority: 'high',
            requireAck: true,
            ackTimeout: 3000
        });
    }

    // Envoyer le statut de l'engine
    sendStatus(statusData) {
        return this.send('status_report', {
            engine: statusData
        }, {
            priority: 'low',
            requireAck: false
        });
    }

    // Envoyer un log
    sendLog(level, message, data = {}) {
        return this.send('log', {
            level,
            message,
            data
        }, {
            priority: 'low',
            requireAck: false
        });
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    generateCorrelationId() {
        return `corr_${++this.correlationId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    }

    generateAckId() {
        return `ack_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    }

    clearTimers() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    emit(event, data) {
        // Dispatcher l'événement sur le window pour compatibilité
        if (globalThis.__engine?.eventBus) {
            globalThis.__engine.eventBus.dispatchEvent(new CustomEvent(`ws:${event}`, { detail: data }));
        }
    }

    getState() {
        return {
            connected: this.state.connected,
            authenticated: this.state.authenticated,
            paired: this.state.paired,
            wsState: this.ws?.readyState,
            queueSize: this.sendQueue.length,
            pendingAcks: this.pendingAcks.size,
            pendingCorrelations: this.pendingCorrelations.size,
            reconnectAttempts: this.state.reconnectAttempts,
            metrics: { ...this.metrics },
            uptime: this.metrics.startTime ? Date.now() - this.metrics.startTime : 0
        };
    }

    getMetrics() {
        return { ...this.metrics, uptime: this.metrics.startTime ? Date.now() - this.metrics.startTime : 0 };
    }

    destroy() {
        this.disconnect();
        this.onOpen = null;
        this.onClose = null;
        this.onError = null;
        this.onMessage = null;
        this.onAuthenticated = null;
        this.onPaired = null;
        this.onReconnect = null;
    }
}

// Exporter
globalThis.EngineWebSocket = EngineWebSocket;
