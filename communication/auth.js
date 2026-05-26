// communication/auth.js - Système d'authentification
// Gère l'identité unique, les tokens, la rotation des clés

class EngineAuth {
    constructor(config = {}) {
        this.config = {
            storageKey: 'engine_auth',
            tokenRefreshMargin: 300000,     // 5 minutes avant expiration
            maxSessionDuration: 86400000,   // 24 heures
            maxTokenAge: 3600000,           // 1 heure
            encryptionAlgorithm: 'AES-GCM',
            ...config
        };

        // Identité persistante
        this.identity = null;
        this.session = null;
        this.keys = null;

        // Callbacks
        this.onTokenRefresh = null;
        this.onSessionExpired = null;
        this.onAuthStateChange = null;

        // Timers
        this.refreshTimer = null;

        console.log('[Auth] Initialisé');
    }

    // ==========================================
    // INITIALISATION
    // ==========================================

    async init() {
        console.log('[Auth] Chargement de l\'identité...');

        // Charger depuis le storage
        const stored = await this.loadFromStorage();

        if (stored) {
            this.identity = stored.identity;
            this.session = stored.session;
            this.keys = stored.keys;

            console.log('[Auth] Identité chargée | clientId:', this.identity?.clientId?.substring(0, 8));

            // Vérifier si la session est valide
            if (this.session && this.isSessionValid()) {
                console.log('[Auth] Session valide');
                this.startRefreshTimer();
            } else {
                console.log('[Auth] Session expirée, nouvelle session nécessaire');
                this.session = null;
            }
        } else {
            console.log('[Auth] Aucune identité existante, création...');
            await this.createIdentity();
        }

        return this.getAuthState();
    }

    // ==========================================
    // CRÉATION D'IDENTITÉ
    // ==========================================

    async createIdentity() {
        // Générer un clientId unique et persistant
        const clientId = this.generateClientId();
        const deviceId = this.generateDeviceId();

        this.identity = {
            clientId,
            deviceId,
            createdAt: Date.now(),
            version: '2.0.0',
            platform: 'extension',
            userAgent: navigator.userAgent,
            screenResolution: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            language: navigator.language
        };

        // Générer une paire de clés pour la signature
        this.keys = await this.generateKeyPair();

        // Sauvegarder
        await this.saveToStorage();

        console.log('[Auth] ✓ Identité créée | clientId:', clientId.substring(0, 8));

        if (this.onAuthStateChange) {
            this.onAuthStateChange({ type: 'identity_created', identity: this.identity });
        }

        return this.identity;
    }

    // ==========================================
    // SESSION
    // ==========================================

    async createSession(sessionToken) {
        this.session = {
            token: sessionToken,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.config.maxSessionDuration,
            lastActivity: Date.now()
        };

        await this.saveToStorage();
        this.startRefreshTimer();

        console.log('[Auth] ✓ Session créée, expire dans 24h');

        if (this.onAuthStateChange) {
            this.onAuthStateChange({ type: 'session_created', session: this.session });
        }

        return this.session;
    }

    async refreshSession(newToken) {
        if (!this.session) return false;

        this.session.token = newToken;
        this.session.createdAt = Date.now();
        this.session.expiresAt = Date.now() + this.config.maxSessionDuration;
        this.session.lastActivity = Date.now();

        await this.saveToStorage();
        this.restartRefreshTimer();

        console.log('[Auth] ✓ Session rafraîchie');

        if (this.onTokenRefresh) {
            this.onTokenRefresh(this.session);
        }
        if (this.onAuthStateChange) {
            this.onAuthStateChange({ type: 'session_refreshed', session: this.session });
        }

        return true;
    }

    invalidateSession(reason = 'unknown') {
        this.session = null;
        this.saveToStorage();
        this.stopRefreshTimer();

        console.log('[Auth] Session invalidée:', reason);

        if (this.onSessionExpired) {
            this.onSessionExpired({ reason });
        }
        if (this.onAuthStateChange) {
            this.onAuthStateChange({ type: 'session_invalidated', reason });
        }
    }

    isSessionValid() {
        if (!this.session) return false;
        if (!this.session.token) return false;
        if (Date.now() > this.session.expiresAt) return false;
        return true;
    }

    // ==========================================
    // TIMER DE RAFRAÎCHISSEMENT
    // ==========================================

    startRefreshTimer() {
        this.stopRefreshTimer();

        if (!this.session) return;

        const timeUntilExpiry = this.session.expiresAt - Date.now();
        const refreshIn = Math.max(0, timeUntilExpiry - this.config.tokenRefreshMargin);

        if (refreshIn <= 0) {
            // Déjà dans la marge, besoin de rafraîchir
            if (this.onTokenRefresh) {
                this.onTokenRefresh(this.session);
            }
            return;
        }

        console.log(`[Auth] Rafraîchissement programmé dans ${Math.round(refreshIn / 60000)} min`);

        this.refreshTimer = setTimeout(() => {
            if (this.onTokenRefresh) {
                this.onTokenRefresh(this.session);
            }
        }, refreshIn);
    }

    stopRefreshTimer() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    restartRefreshTimer() {
        this.startRefreshTimer();
    }

    // ==========================================
    // SIGNATURE ET CHIFFREMENT
    // ==========================================

    async generateKeyPair() {
        try {
            // Utiliser SubtleCrypto si disponible
            if (window.crypto?.subtle) {
                const keyPair = await crypto.subtle.generateKey(
                    {
                        name: 'RSA-OAEP',
                        modulusLength: 2048,
                        publicExponent: new Uint8Array([1, 0, 1]),
                        hash: 'SHA-256'
                    },
                    true,
                    ['encrypt', 'decrypt']
                );

                const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
                const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

                return {
                    algorithm: 'RSA-OAEP-2048',
                    publicKey: publicKeyJwk,
                    privateKey: privateKeyJwk,
                    createdAt: Date.now()
                };
            }
        } catch (e) {
            console.warn('[Auth] SubtleCrypto non disponible, fallback signature simple');
        }

        // Fallback: signature HMAC-like
        return {
            algorithm: 'simple-hash',
            secret: this.generateSimpleSecret(),
            createdAt: Date.now()
        };
    }

    async signMessage(message) {
        const payload = typeof message === 'string' ? message : JSON.stringify(message);
        
        if (this.keys?.algorithm === 'RSA-OAEP-2048' && window.crypto?.subtle) {
            try {
                const privateKey = await crypto.subtle.importKey(
                    'jwk', this.keys.privateKey,
                    { name: 'RSA-OAEP', hash: 'SHA-256' },
                    false, ['decrypt']
                );

                const encoder = new TextEncoder();
                const data = encoder.encode(payload);
                const signature = await crypto.subtle.sign(
                    { name: 'RSA-PSS', saltLength: 32 },
                    privateKey,
                    data
                );

                return {
                    signature: Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join(''),
                    algorithm: 'RSA-PSS-256',
                    timestamp: Date.now(),
                    clientId: this.identity?.clientId
                };
            } catch (e) {
                console.warn('[Auth] Erreur signature RSA:', e);
            }
        }

        // Fallback: signature simple
        const data = payload + this.keys?.secret + Date.now();
        const hash = await this.simpleHash(data);
        
        return {
            signature: hash,
            algorithm: 'simple-hash',
            timestamp: Date.now(),
            clientId: this.identity?.clientId
        };
    }

    async simpleHash(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        
        if (window.crypto?.subtle) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        // Fallback: hash simple
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }

    generateSimpleSecret() {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }

    // ==========================================
    // GÉNÉRATION D'IDENTIFIANT
    // ==========================================

    generateClientId() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        
        // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (UUID v4)
        array[6] = (array[6] & 0x0f) | 0x40;
        array[8] = (array[8] & 0x3f) | 0x80;
        
        const hex = Array.from(array, b => b.toString(16).padStart(2, '0'));
        return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
    }

    generateDeviceId() {
        const components = [
            navigator.userAgent || 'unknown',
            navigator.platform || 'unknown',
            screen.width,
            screen.height,
            navigator.language || 'unknown'
        ];
        
        const seed = components.join('|');
        let hash = 0;
        
        for (let i = 0; i < seed.length; i++) {
            const char = seed.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return `ext_${Math.abs(hash).toString(16)}_${Date.now().toString(36)}`;
    }

    // ==========================================
    // STOCKAGE PERSISTANT
    // ==========================================

    async saveToStorage() {
        const data = {
            identity: this.identity,
            session: this.session,
            keys: this.keys
        };

        try {
            await chrome.storage.local.set({ [this.config.storageKey]: data });
        } catch (e) {
            console.error('[Auth] Erreur sauvegarde:', e);
        }
    }

    async loadFromStorage() {
        try {
            const result = await chrome.storage.local.get(this.config.storageKey);
            return result[this.config.storageKey] || null;
        } catch (e) {
            console.error('[Auth] Erreur chargement:', e);
            return null;
        }
    }

    async clearStorage() {
        try {
            await chrome.storage.local.remove(this.config.storageKey);
        } catch (e) {
            console.error('[Auth] Erreur nettoyage:', e);
        }
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    getClientId() {
        return this.identity?.clientId || null;
    }

    getDeviceId() {
        return this.identity?.deviceId || null;
    }

    getSessionToken() {
        return this.session?.token || null;
    }

    getIdentity() {
        return this.identity ? { ...this.identity } : null;
    }

    getAuthState() {
        return {
            hasIdentity: !!this.identity,
            hasSession: !!this.session,
            sessionValid: this.isSessionValid(),
            clientId: this.identity?.clientId || null,
            deviceId: this.identity?.deviceId || null,
            hasKeys: !!this.keys,
            sessionExpiresAt: this.session?.expiresAt || null,
            createdAt: this.identity?.createdAt || null
        };
    }

    async destroy() {
        this.stopRefreshTimer();
        await this.clearStorage();
        this.identity = null;
        this.session = null;
        this.keys = null;
        
        if (this.onAuthStateChange) {
            this.onAuthStateChange({ type: 'destroyed' });
        }
    }
}

// Exporter
window.EngineAuth = EngineAuth;
