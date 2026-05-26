// communication/sync.js - Synchronisation des données entre extension et backend
// Gère le cache local, la réconciliation, le versioning

class EngineSync {
    constructor(config = {}) {
        this.config = {
            storageKey: 'engine_sync',
            maxCacheSize: 500,           // Nombre maximum d'entrées en cache
            syncInterval: 30000,         // 30 secondes entre syncs
            batchSize: 50,              // Taille des lots pour la synchronisation
            conflictResolution: 'server_wins', // server_wins | client_wins | last_write_wins
            retryAttempts: 3,
            retryDelay: 5000,
            compressionThreshold: 10240, // 10KB seuil de compression
            ...config
        };

        this.state = {
            initialized: false,
            syncing: false,
            lastSync: null,
            pendingChanges: 0,
            conflicts: 0,
            version: 0
        };

        // Collections locales
        this.cache = {
            analyses: [],
            predictions: [],
            cells: [],
            patterns: [],
            metrics: []
        };

        // File de synchronisation
        this.syncQueue = [];
        this.syncResults = [];
        this.pendingSyncs = new Map();

        // Timers
        this.syncTimer = null;
        this.retryTimer = null;

        // Callbacks
        this.onSyncStart = null;
        this.onSyncComplete = null;
        this.onSyncError = null;
        this.onConflict = null;
        this.onDataReceived = null;

        // WebSocket reference
        this.ws = null;

        console.log('[Sync] Initialisé');
    }

    // ==========================================
    // INITIALISATION
    // ==========================================

    async init(wsInstance) {
        this.ws = wsInstance;

        // Charger le cache depuis le storage
        await this.loadCache();

        // Restaurer l'état
        const stored = await this.loadState();
        if (stored) {
            this.state.version = stored.version || 0;
            this.state.lastSync = stored.lastSync || null;
        }

        this.state.initialized = true;

        // Démarrer le cycle de sync
        this.startSyncCycle();

        console.log(`[Sync] ✓ Initialisé | Cache: ${this.getCacheSize()} entrées | Version: ${this.state.version}`);

        return true;
    }

    // ==========================================
    // MISE EN CACHE LOCALE
    // ==========================================

    async cacheAnalysis(analysisData) {
        const entry = {
            id: `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'analysis',
            data: analysisData,
            version: this.state.version + 1,
            timestamp: Date.now(),
            synced: false
        };

        this.cache.analyses.push(entry);
        this.state.version++;
        this.state.pendingChanges++;

        // Ajouter à la file de sync
        this.syncQueue.push(entry);

        // Limiter la taille
        if (this.cache.analyses.length > this.config.maxCacheSize) {
            this.cache.analyses.splice(0, this.cache.analyses.length - this.config.maxCacheSize);
        }

        await this.persistCache();

        if (this.config.debug) {
            console.log(`[Sync] Analyse mise en cache (${this.state.pendingChanges} en attente)`);
        }

        return entry.id;
    }

    async cachePrediction(predictionData) {
        const entry = {
            id: `prediction_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'prediction',
            data: predictionData,
            version: this.state.version + 1,
            timestamp: Date.now(),
            synced: false
        };

        this.cache.predictions.push(entry);
        this.state.version++;
        this.state.pendingChanges++;
        this.syncQueue.push(entry);

        if (this.cache.predictions.length > this.config.maxCacheSize) {
            this.cache.predictions.splice(0, this.cache.predictions.length - this.config.maxCacheSize);
        }

        await this.persistCache();
        return entry.id;
    }

    async cacheCells(cellsData) {
        const entry = {
            id: `cells_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'cells',
            data: cellsData,
            version: this.state.version + 1,
            timestamp: Date.now(),
            synced: false
        };

        this.cache.cells.push(entry);
        this.state.version++;
        this.state.pendingChanges++;
        this.syncQueue.push(entry);

        if (this.cache.cells.length > this.config.maxCacheSize) {
            this.cache.cells.splice(0, this.cache.cells.length - this.config.maxCacheSize);
        }

        await this.persistCache();
        return entry.id;
    }

    // ==========================================
    // SYNCHRONISATION
    // ==========================================

    startSyncCycle() {
        this.stopSyncCycle();

        this.syncTimer = setInterval(() => {
            if (this.state.pendingChanges > 0 && !this.state.syncing) {
                this.sync();
            }
        }, this.config.syncInterval);

        console.log(`[Sync] Cycle démarré (intervalle: ${this.config.syncInterval / 1000}s)`);
    }

    stopSyncCycle() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    async sync(force = false) {
        if (this.state.syncing) {
            console.log('[Sync] Déjà en cours de synchronisation');
            return;
        }

        if (this.syncQueue.length === 0 && !force) {
            return;
        }

        this.state.syncing = true;

        if (this.onSyncStart) this.onSyncStart({
            pendingCount: this.syncQueue.length,
            timestamp: Date.now()
        });

        try {
            // Préparer les lots
            const batches = this.prepareBatches();
            let syncedCount = 0;
            let failedCount = 0;

            for (const batch of batches) {
                const result = await this.sendBatch(batch);
                
                if (result.success) {
                    syncedCount += batch.length;
                    
                    // Marquer comme synchronisé
                    for (const entry of batch) {
                        entry.synced = true;
                    }
                } else {
                    failedCount += batch.length;
                    
                    // Gérer les conflits
                    if (result.conflicts) {
                        this.handleConflicts(result.conflicts);
                    }
                }
            }

            // Nettoyer la file
            this.syncQueue = this.syncQueue.filter(e => !e.synced);
            this.state.pendingChanges = this.syncQueue.length;
            this.state.lastSync = Date.now();

            // Persister
            await this.persistCache();
            await this.saveState();

            this.state.syncing = false;

            console.log(`[Sync] ✓ Synchronisé: ${syncedCount} envoyés, ${failedCount} échoués`);

            if (this.onSyncComplete) {
                this.onSyncComplete({
                    syncedCount,
                    failedCount,
                    pendingCount: this.state.pendingChanges,
                    timestamp: Date.now()
                });
            }

        } catch (e) {
            this.state.syncing = false;
            console.error('[Sync] Erreur synchronisation:', e);
            
            if (this.onSyncError) this.onSyncError(e);
        }
    }

    prepareBatches() {
        const batches = [];
        const unsynced = this.syncQueue.filter(e => !e.synced);

        for (let i = 0; i < unsynced.length; i += this.config.batchSize) {
            batches.push(unsynced.slice(i, i + this.config.batchSize));
        }

        return batches;
    }

    async sendBatch(batch) {
        // Compresser si nécessaire
        const payload = {
            clientId: this.ws?.clientId,
            batchId: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            entries: batch.map(e => ({
                id: e.id,
                type: e.type,
                data: e.data,
                version: e.version,
                timestamp: e.timestamp
            })),
            totalCount: batch.length,
            timestamp: Date.now(),
            compressed: false
        };

        // Compression si trop gros
        const payloadStr = JSON.stringify(payload);
        if (payloadStr.length > this.config.compressionThreshold) {
            payload.compressed = true;
            payload.data = await this.compress(payloadStr);
        }

        // Envoyer via WebSocket
        try {
            const response = await this.ws.send('sync_batch', payload, {
                requireAck: true,
                ackTimeout: 15000,
                waitForCorrelation: true,
                correlationTimeout: 20000
            });

            return {
                success: true,
                batchId: payload.batchId,
                response,
                conflicts: response?.conflicts || []
            };

        } catch (e) {
            console.error('[Sync] Erreur envoi batch:', e);
            
            // Tentatives de réessai
            for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
                console.log(`[Sync] Tentative ${attempt}/${this.config.retryAttempts}...`);
                
                await this.delay(this.config.retryDelay * attempt);
                
                try {
                    const response = await this.ws.send('sync_batch', payload, {
                        requireAck: true,
                        ackTimeout: 15000,
                        waitForCorrelation: true,
                        correlationTimeout: 20000
                    });

                    return {
                        success: true,
                        batchId: payload.batchId,
                        response,
                        conflicts: response?.conflicts || []
                    };

                } catch (retryError) {
                    if (attempt === this.config.retryAttempts) {
                        return {
                            success: false,
                            batchId: payload.batchId,
                            error: retryError.message,
                            conflicts: []
                        };
                    }
                }
            }
        }
    }

    // ==========================================
    // RÉCEPTION DE DONNÉES
    // ==========================================

    async receiveData(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'sync_response':
                await this.handleSyncResponse(data);
                break;

            case 'data_push':
                await this.handleDataPush(data);
                break;

            case 'conflict_resolution':
                await this.handleConflictResolution(data);
                break;

            case 'full_sync':
                await this.handleFullSync(data);
                break;
        }

        if (this.onDataReceived) {
            this.onDataReceived(data);
        }
    }

    async handleSyncResponse(data) {
        // Marquer les entrées comme synchronisées
        if (data.syncedIds) {
            for (const id of data.syncedIds) {
                const entry = this.findEntryById(id);
                if (entry) {
                    entry.synced = true;
                }
            }

            this.syncQueue = this.syncQueue.filter(e => !e.synced);
            this.state.pendingChanges = this.syncQueue.length;

            await this.persistCache();
        }
    }

    async handleDataPush(data) {
        // Données poussées par le backend (config, commandes, etc.)
        if (data.payload) {
            // Stocker
            await chrome.storage.local.set({
                'engine_pushed_data': {
                    data: data.payload,
                    receivedAt: Date.now()
                }
            });

            console.log('[Sync] Données reçues du backend:', data.payload.type);
        }
    }

    async handleConflictResolution(data) {
        this.state.conflicts++;

        if (this.onConflict) {
            this.onConflict(data);
        }

        // Appliquer la résolution selon la stratégie
        switch (this.config.conflictResolution) {
            case 'server_wins':
                // Remplacer par les données serveur
                if (data.serverData) {
                    await this.applyServerData(data.serverData);
                }
                break;

            case 'client_wins':
                // Garder les données locales, renvoyer
                if (data.entryId) {
                    const entry = this.findEntryById(data.entryId);
                    if (entry) {
                        this.syncQueue.push(entry);
                    }
                }
                break;

            case 'last_write_wins':
                // Garder la version la plus récente
                if (data.serverData && data.serverData.timestamp > (data.clientTimestamp || 0)) {
                    await this.applyServerData(data.serverData);
                }
                break;
        }
    }

    async handleFullSync(data) {
        console.log('[Sync] Synchronisation complète demandée');

        if (data.fullData) {
            // Remplacer tout le cache
            this.cache = {
                analyses: [],
                predictions: [],
                cells: [],
                patterns: [],
                metrics: []
            };

            if (data.fullData.analyses) {
                this.cache.analyses = data.fullData.analyses.map(a => ({ ...a, synced: true }));
            }
            if (data.fullData.predictions) {
                this.cache.predictions = data.fullData.predictions.map(p => ({ ...p, synced: true }));
            }
            if (data.fullData.cells) {
                this.cache.cells = data.fullData.cells.map(c => ({ ...c, synced: true }));
            }

            this.syncQueue = [];
            this.state.pendingChanges = 0;
            this.state.lastSync = Date.now();

            await this.persistCache();

            console.log(`[Sync] ✓ Sync complète: ${this.getCacheSize()} entrées reçues`);
        }
    }

    // ==========================================
    // GESTION DES CONFLITS
    // ==========================================

    async handleConflicts(conflicts) {
        if (!conflicts || conflicts.length === 0) return;

        console.log(`[Sync] ${conflicts.length} conflit(s) détecté(s)`);

        for (const conflict of conflicts) {
            const localEntry = this.findEntryById(conflict.entryId);
            
            if (localEntry) {
                // Logique de résolution
                switch (this.config.conflictResolution) {
                    case 'server_wins':
                        localEntry.data = conflict.serverData;
                        localEntry.synced = true;
                        break;

                    case 'client_wins':
                        // Renvoyer la version locale
                        localEntry.synced = false;
                        this.syncQueue.push(localEntry);
                        break;

                    case 'last_write_wins':
                        if ((conflict.serverTimestamp || 0) > (localEntry.timestamp || 0)) {
                            localEntry.data = conflict.serverData;
                            localEntry.synced = true;
                        } else {
                            localEntry.synced = false;
                            this.syncQueue.push(localEntry);
                        }
                        break;
                }

                this.state.conflicts++;

                if (this.onConflict) {
                    this.onConflict({
                        entryId: conflict.entryId,
                        resolution: this.config.conflictResolution,
                        timestamp: Date.now()
                    });
                }
            }
        }

        await this.persistCache();
    }

    // ==========================================
    // APPLICATION DE DONNÉES SERVEUR
    // ==========================================

    async applyServerData(serverData) {
        if (!serverData) return;

        for (const entry of serverData) {
            if (!entry.id || !entry.type) continue;

            // Trouver et remplacer dans le cache
            for (const [cacheKey, cacheArray] of Object.entries(this.cache)) {
                const existingIndex = cacheArray.findIndex(e => e.id === entry.id);
                if (existingIndex >= 0) {
                    cacheArray[existingIndex] = {
                        ...entry,
                        synced: true,
                        serverOverride: true
                    };
                    break;
                }
            }
        }

        await this.persistCache();
    }

    // ==========================================
    // COMPRESSION
    // ==========================================

    async compress(data) {
        if (typeof data !== 'string') {
            data = JSON.stringify(data);
        }

        try {
            // Utiliser CompressionStream si disponible
            if (typeof CompressionStream !== 'undefined') {
                const encoder = new TextEncoder();
                const compressed = await new Promise((resolve, reject) => {
                    const cs = new CompressionStream('gzip');
                    const writer = cs.writable.getWriter();
                    const reader = cs.readable.getReader();
                    const chunks = [];

                    writer.write(encoder.encode(data));
                    writer.close();

                    reader.read().then(function process({ done, value }) {
                        if (done) {
                            resolve(new Blob(chunks));
                            return;
                        }
                        chunks.push(value);
                        return reader.read().then(process);
                    }).catch(reject);
                });

                const buffer = await compressed.arrayBuffer();
                return Array.from(new Uint8Array(buffer)).map(b => String.fromCharCode(b)).join('');
            }
        } catch (e) {
            console.warn('[Sync] Compression non disponible, envoi en clair');
        }

        return data;
    }

    async decompress(data) {
        try {
            if (typeof CompressionStream !== 'undefined') {
                const encoder = new TextEncoder();
                const compressed = await new Response(
                    new Blob([encoder.encode(data)])
                ).arrayBuffer();

                // Décompression
                const decompressed = await new Promise((resolve, reject) => {
                    const ds = new DecompressionStream('gzip');
                    const writer = ds.writable.getWriter();
                    const reader = ds.readable.getReader();
                    const chunks = [];

                    writer.write(new Uint8Array(compressed));
                    writer.close();

                    reader.read().then(function process({ done, value }) {
                        if (done) {
                            const decoder = new TextDecoder();
                            resolve(chunks.reduce((acc, c) => acc + decoder.decode(c, { stream: true }), ''));
                            return;
                        }
                        chunks.push(value);
                        return reader.read().then(process);
                    }).catch(reject);
                });

                return JSON.parse(decompressed);
            }
        } catch (e) {
            console.warn('[Sync] Décompression échouée');
        }

        return JSON.parse(data);
    }

    // ==========================================
    // STOCKAGE PERSISTANT
    // ==========================================

    async persistCache() {
        try {
            await chrome.storage.local.set({
                [this.config.storageKey]: this.cache
            });
        } catch (e) {
            console.error('[Sync] Erreur persistance cache:', e);
        }
    }

    async loadCache() {
        try {
            const stored = await chrome.storage.local.get(this.config.storageKey);
            if (stored[this.config.storageKey]) {
                this.cache = stored[this.config.storageKey];
                console.log(`[Sync] Cache chargé: ${this.getCacheSize()} entrées`);
            }
        } catch (e) {
            console.error('[Sync] Erreur chargement cache:', e);
        }
    }

    async saveState() {
        try {
            await chrome.storage.local.set({
                'engine_sync_state': {
                    version: this.state.version,
                    lastSync: this.state.lastSync
                }
            });
        } catch (e) {
            console.error('[Sync] Erreur sauvegarde état:', e);
        }
    }

    async loadState() {
        try {
            const stored = await chrome.storage.local.get('engine_sync_state');
            return stored.engine_sync_state || null;
        } catch (e) {
            return null;
        }
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    findEntryById(id) {
        for (const cacheArray of Object.values(this.cache)) {
            const found = cacheArray.find(e => e.id === id);
            if (found) return found;
        }
        return null;
    }

    getCacheSize() {
        return Object.values(this.cache).reduce((sum, arr) => sum + arr.length, 0);
    }

    getSyncState() {
        return {
            initialized: this.state.initialized,
            syncing: this.state.syncing,
            lastSync: this.state.lastSync,
            pendingChanges: this.state.pendingChanges,
            queueLength: this.syncQueue.length,
            cacheSize: this.getCacheSize(),
            conflicts: this.state.conflicts,
            version: this.state.version
        };
    }

    getCachedData(type, limit = 10) {
        if (type && this.cache[type]) {
            return this.cache[type].slice(-limit);
        }
        return {};
    }

    async clearCache() {
        this.cache = {
            analyses: [],
            predictions: [],
            cells: [],
            patterns: [],
            metrics: []
        };
        this.syncQueue = [];
        this.state.pendingChanges = 0;
        this.state.version = 0;

        await this.persistCache();
        await this.saveState();

        console.log('[Sync] Cache vidé');
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async forceFullSync() {
        console.log('[Sync] Synchronisation complète forcée');
        return this.sync(true);
    }

    destroy() {
        this.stopSyncCycle();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.syncQueue = [];
        this.pendingSyncs.clear();
        this.ws = null;
    }
}

// Exporter
globalThis.EngineSync = EngineSync;
