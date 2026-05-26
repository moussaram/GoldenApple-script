// communication/pairing.js - Système d'appairage extension ↔ application mobile
// Permet de lier une instance d'extension à un appareil mobile via code QR

class EnginePairing {
    constructor(config = {}) {
        this.config = {
            codeLength: 6,
            codeExpiry: 120000,      // 2 minutes
            maxPairingAttempts: 5,
            pairingCooldown: 30000,  // 30 secondes entre tentatives
            encryptionKey: null,
            ...config
        };

        this.state = {
            paired: false,
            pairing: false,
            deviceInfo: null,
            currentCode: null,
            codeExpiresAt: null,
            attempts: 0,
            lastAttempt: 0,
            lastError: null
        };

        this.onCodeGenerated = null;
        this.onPaired = null;
        this.onPairError = null;
        this.onUnpaired = null;
        this.onPairingTimeout = null;

        this.codeTimer = null;
        this.cleanupTimer = null;

        console.log('[Pairing] Initialisé');
    }

    // ==========================================
    // GÉNÉRATION DE CODE
    // ==========================================

    async generatePairCode() {
        // Vérifier le cooldown
        if (Date.now() - this.state.lastAttempt < this.config.pairingCooldown) {
            const remaining = Math.ceil((this.config.pairingCooldown - (Date.now() - this.state.lastAttempt)) / 1000);
            const error = `Veuillez attendre ${remaining}s avant de générer un nouveau code`;
            console.warn('[Pairing]', error);
            
            if (this.onPairError) this.onPairError({ code: 'cooldown', message: error, remaining });
            return null;
        }

        // Vérifier le nombre de tentatives
        if (this.state.attempts >= this.config.maxPairingAttempts) {
            const error = `Nombre maximum de tentatives atteint (${this.config.maxPairingAttempts})`;
            console.error('[Pairing]', error);
            
            // Réinitialiser après un délai plus long
            setTimeout(() => {
                this.state.attempts = 0;
            }, 300000); // 5 minutes

            if (this.onPairError) this.onPairError({ code: 'max_attempts', message: error });
            return null;
        }

        this.state.pairing = true;
        this.state.attempts++;
        this.state.lastAttempt = Date.now();

        // Générer le code
        const code = this.generateRandomCode();
        this.state.currentCode = code;
        this.state.codeExpiresAt = Date.now() + this.config.codeExpiry;

        console.log(`[Pairing] Code généré: ${code} (expire dans ${this.config.codeExpiry / 1000}s)`);

        // Démarrer le timer d'expiration
        this.startCodeTimer();

        // Callback
        if (this.onCodeGenerated) {
            this.onCodeGenerated({
                code,
                expiresAt: this.state.codeExpiresAt,
                expiresIn: this.config.codeExpiry / 1000
            });
        }

        return {
            code,
            expiresAt: this.state.codeExpiresAt,
            expiresIn: this.config.codeExpiry / 1000,
            attempt: this.state.attempts,
            maxAttempts: this.config.maxPairingAttempts
        };
    }

    // ==========================================
    // VALIDATION DE CODE
    // ==========================================

    async validatePairCode(code, deviceInfo = {}) {
        // Vérifications
        if (this.state.paired) {
            return { success: false, error: 'already_paired', message: 'Déjà appairé' };
        }

        if (!this.state.pairing || !this.state.currentCode) {
            return { success: false, error: 'no_code', message: 'Aucun code actif' };
        }

        if (Date.now() > this.state.codeExpiresAt) {
            this.state.pairing = false;
            this.state.currentCode = null;
            
            if (this.onPairingTimeout) this.onPairingTimeout();
            
            return { success: false, error: 'code_expired', message: 'Code expiré' };
        }

        if (code !== this.state.currentCode) {
            const errorMsg = `Code invalide: ${code} !== ${this.state.currentCode}`;
            console.warn('[Pairing]', errorMsg);
            
            if (this.onPairError) this.onPairError({ code: 'invalid_code', message: 'Code incorrect' });
            
            return { success: false, error: 'invalid_code', message: 'Code incorrect' };
        }

        // Succès de l'appairage
        this.state.paired = true;
        this.state.pairing = false;
        this.state.deviceInfo = {
            ...deviceInfo,
            pairedAt: Date.now(),
            deviceId: deviceInfo.deviceId || `mobile_${Date.now().toString(36)}`,
            deviceName: deviceInfo.deviceName || 'Appareil mobile'
        };

        this.cleanupCode();
        this.stopCodeTimer();

        // Stocker l'appairage
        await this.savePairingState();

        console.log('[Pairing] ✓ Appairé avec:', this.state.deviceInfo.deviceName);

        if (this.onPaired) {
            this.onPaired(this.state.deviceInfo);
        }

        return {
            success: true,
            device: this.state.deviceInfo,
            message: `Appairé avec ${this.state.deviceInfo.deviceName}`
        };
    }

    // ==========================================
    // GESTION DE L'APPAIRAGE
    // ==========================================

    async unpair(reason = 'user_request') {
        if (!this.state.paired) return false;

        console.log('[Pairing] Désappairage:', reason);

        this.state.paired = false;
        this.state.deviceInfo = null;
        this.state.currentCode = null;

        await this.clearPairingState();

        if (this.onUnpaired) {
            this.onUnpaired({ reason, timestamp: Date.now() });
        }

        return true;
    }

    async restorePairing() {
        try {
            const stored = await chrome.storage.local.get('engine_pairing');
            if (stored.engine_pairing) {
                this.state.paired = stored.engine_pairing.paired || false;
                this.state.deviceInfo = stored.engine_pairing.deviceInfo || null;
                
                if (this.state.paired && this.state.deviceInfo) {
                    console.log('[Pairing] ✓ Appairage restauré:', this.state.deviceInfo.deviceName);
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Pairing] Erreur restauration:', e);
        }
        return false;
    }

    // ==========================================
    // TIMERS
    // ==========================================

    startCodeTimer() {
        this.stopCodeTimer();

        const expiresIn = Math.max(0, this.state.codeExpiresAt - Date.now());

        this.codeTimer = setTimeout(() => {
            console.log('[Pairing] Code expiré');
            this.state.pairing = false;
            this.state.currentCode = null;
            
            if (this.onPairingTimeout) this.onPairingTimeout();
        }, expiresIn);
    }

    stopCodeTimer() {
        if (this.codeTimer) {
            clearTimeout(this.codeTimer);
            this.codeTimer = null;
        }
    }

    cleanupCode() {
        this.state.currentCode = null;
        this.state.codeExpiresAt = null;
        this.state.pairing = false;
    }

    // ==========================================
    // STOCKAGE
    // ==========================================

    async savePairingState() {
        try {
            await chrome.storage.local.set({
                engine_pairing: {
                    paired: this.state.paired,
                    deviceInfo: this.state.deviceInfo,
                    pairedAt: Date.now()
                }
            });
        } catch (e) {
            console.error('[Pairing] Erreur sauvegarde:', e);
        }
    }

    async clearPairingState() {
        try {
            await chrome.storage.local.remove('engine_pairing');
        } catch (e) {
            console.error('[Pairing] Erreur nettoyage:', e);
        }
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    generateRandomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sans I,O,0,1 pour éviter confusion
        let code = '';
        
        for (let i = 0; i < this.config.codeLength; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        // Formater: XXX-XXX
        const mid = Math.ceil(this.config.codeLength / 2);
        return code.substring(0, mid) + '-' + code.substring(mid);
    }

    getPairingState() {
        return {
            paired: this.state.paired,
            pairing: this.state.pairing,
            hasCode: !!this.state.currentCode,
            code: this.state.currentCode,
            codeExpiresAt: this.state.codeExpiresAt,
            codeExpiresIn: this.state.codeExpiresAt ? Math.max(0, Math.floor((this.state.codeExpiresAt - Date.now()) / 1000)) : 0,
            device: this.state.deviceInfo,
            attempts: this.state.attempts,
            maxAttempts: this.config.maxPairingAttempts,
            lastError: this.state.lastError
        };
    }

    getDeviceInfo() {
        return this.state.deviceInfo ? { ...this.state.deviceInfo } : null;
    }

    isPaired() {
        return this.state.paired;
    }

    isPairing() {
        return this.state.pairing;
    }

    destroy() {
        this.stopCodeTimer();
        this.clearPairingState();
        this.state = {
            paired: false,
            pairing: false,
            deviceInfo: null,
            currentCode: null,
            codeExpiresAt: null,
            attempts: 0,
            lastAttempt: 0,
            lastError: null
        };
    }
}

// Exporter
globalThis.EnginePairing = EnginePairing;
