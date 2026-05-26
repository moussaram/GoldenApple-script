// content.js - Point d'entrée du moteur dans la page
// Orchestre analyzer.js, detector.js, predictor.js

(function() {
    'use strict';

    const ENGINE = {
        initialized: false,
        state: 'idle', // idle | scanning | analyzing | paused
        platform: null,
        tabId: null,
        currentRound: null,
        modules: {
            analyzer: null,
            detector: null,
            predictor: null
        },
        config: {
            scanInterval: 200,
            confidenceThreshold: 0.6,
            autoAnalyze: true,
            debug: false
        },
        metrics: {
            startTime: null,
            roundsAnalyzed: 0,
            cellsFound: 0,
            predictionsMade: 0
        },
        cycleTimer: null
    };

    // ==========================================
    // INITIALISATION
    // ==========================================

    function init() {
        if (ENGINE.initialized) return;
        
        console.log('[Engine] Initialisation du moteur...');
        ENGINE.metrics.startTime = Date.now();
        
        // Détecter la plateforme
        ENGINE.platform = detectPlatform();
        ENGINE.tabId = getTabId();
        
        // Initialiser les modules
        ENGINE.modules.analyzer = new AppleAnalyzer(ENGINE);
        ENGINE.modules.detector = new AppleDetector(ENGINE);
        ENGINE.modules.predictor = new ApplePredictor(ENGINE);
        
        // Lier les modules entre eux
        linkModules();
        
        // Écouter les commandes du background
        listenBackgroundCommands();
        
        // Écouter les events de la page
        listenPageEvents();
        
        ENGINE.initialized = true;
        ENGINE.state = 'scanning';
        
        // Signaler au background que le moteur est prêt
        sendToBackground({
            type: 'ENGINE_STATUS',
            payload: {
                state: ENGINE.state,
                platform: ENGINE.platform,
                tabId: ENGINE.tabId,
                version: '2.0.0'
            }
        });

        // Démarrer le cycle d'analyse
        startAnalysisCycle();

        console.log(`[Engine] ✓ Moteur prêt | Platform: ${ENGINE.platform} | Tab: ${ENGINE.tabId}`);
    }

    // ==========================================
    // DÉTECTION PLATEFORME
    // ==========================================

    function detectPlatform() {
        const hostname = window.location.hostname;
        
        if (hostname.includes('1xbet')) return '1xbet';
        if (hostname.includes('melbet')) return 'melbet';
        if (hostname.includes('winwin')) return 'winwin';
        if (hostname.includes('megapari')) return 'megapari';
        if (hostname.includes('1xgame')) return '1xgame';
        if (hostname.includes('1xslot')) return '1xslot';
        
        // Détection par patterns génériques
        if (document.querySelector('[class*="apple-fortune"], [class*="apple_of_fortune"], .game-apple')) {
            return 'generic_apple';
        }
        
        return 'unknown';
    }

    function getTabId() {
        try {
            const url = new URL(window.location.href);
            return url.pathname + url.search;
        } catch(e) {
            return 'unknown';
        }
    }

    // ==========================================
    // LIER LES MODULES
    // ==========================================

    function linkModules() {
        const { analyzer, detector, predictor } = ENGINE.modules;

        // Quand le détecteur trouve des cellules → les envoyer à l'analyseur
        detector.onDetect = (cells) => {
            sendCellsDetected(cells);
            analyzer.feedCells(cells);
        };

        // Quand l'analyseur a fini d'analyser → envoyer au prédicteur
        analyzer.onAnalyze = (analysis) => {
            predictor.feedAnalysis(analysis);
        };

        // Quand le prédicteur fait une prédiction → l'envoyer au background
        predictor.onPredict = (prediction) => {
            sendPrediction(prediction);
        };

        // Cycle complet
        detector.onDetectComplete = () => {
            if (analyzer.hasData()) {
                analyzer.runAnalysis();
            }
        };
    }

    // ==========================================
    // COMMUNICATION BACKGROUND
    // ==========================================

    function listenBackgroundCommands() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            switch (message.type) {
                case 'ENGINE_COMMAND':
                    handleCommand(message.command, message.params);
                    sendResponse({ received: true, state: ENGINE.state });
                    break;

                case 'TAB_CHANGED':
                    if (message.platform) {
                        ENGINE.platform = message.platform;
                        ENGINE.state = 'scanning';
                    }
                    sendResponse({ received: true });
                    break;

                case 'START_ANALYSIS':
                    ENGINE.state = 'analyzing';
                    startAnalysisCycle();
                    sendResponse({ received: true });
                    break;

                case 'STOP_ANALYSIS':
                    ENGINE.state = 'paused';
                    stopAnalysisCycle();
                    sendResponse({ received: true });
                    break;
            }
            return true;
        });
    }

    function listenPageEvents() {
        // Écouter les mutations du DOM
        const observer = new MutationObserver((mutations) => {
            if (ENGINE.state === 'paused') return;
            
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    ENGINE.modules.detector.scheduleScan();
                    break;
                }
                if (mutation.type === 'attributes') {
                    ENGINE.modules.detector.scheduleScan();
                    break;
                }
            }
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'data-state', 'data-cell']
        });

        // Écouter les clics (mises du joueur)
        document.addEventListener('click', (e) => {
            if (ENGINE.state === 'analyzing' || ENGINE.state === 'scanning') {
                const cell = e.target.closest('[class*="apple"], [class*="cell"], [class*="grid"]');
                if (cell) {
                    ENGINE.modules.detector.handleUserClick(cell);
                }
            }
        }, true);
    }

    function handleCommand(command, params) {
        switch (command) {
            case 'START_ANALYSIS':
                ENGINE.state = 'analyzing';
                ENGINE.modules.detector.forceScan();
                break;

            case 'STOP_ANALYSIS':
                ENGINE.state = 'paused';
                stopAnalysisCycle();
                break;

            case 'RESUME_ANALYSIS':
                ENGINE.state = 'scanning';
                startAnalysisCycle();
                break;

            case 'FORCE_SCAN':
                ENGINE.modules.detector.forceScan();
                break;

            case 'SET_CONFIG':
                if (params) Object.assign(ENGINE.config, params);
                break;

            case 'RESET':
                ENGINE.metrics = {
                    startTime: Date.now(),
                    roundsAnalyzed: 0,
                    cellsFound: 0,
                    predictionsMade: 0
                };
                ENGINE.modules.predictor.reset();
                ENGINE.modules.analyzer.reset();
                break;
        }
    }

    // ==========================================
    // CYCLE D'ANALYSE
    // ==========================================

    function startAnalysisCycle() {
        if (ENGINE.state === 'paused') return;
        if (ENGINE.cycleTimer) return;

        const cycle = () => {
            if (ENGINE.state === 'paused') {
                ENGINE.cycleTimer = null;
                return;
            }

            ENGINE.modules.detector.scan();
            
            ENGINE.cycleTimer = setTimeout(cycle, ENGINE.config.scanInterval);
        };

        cycle();
    }

    function stopAnalysisCycle() {
        if (ENGINE.cycleTimer) {
            clearTimeout(ENGINE.cycleTimer);
            ENGINE.cycleTimer = null;
        }
    }

    // ==========================================
    // ENVOI DES RÉSULTATS
    // ==========================================

    function sendToBackground(message) {
        try {
            chrome.runtime.sendMessage(message);
        } catch (e) {
            // Content script detached
        }
    }

    function sendPrediction(prediction) {
        ENGINE.metrics.predictionsMade++;
        
        sendToBackground({
            type: 'PREDICTION_READY',
            payload: {
                ...prediction,
                platform: ENGINE.platform,
                tabId: ENGINE.tabId,
                round: ENGINE.currentRound,
                metrics: { ...ENGINE.metrics }
            }
        });

        if (ENGINE.config.debug) {
            console.log('[Engine] Prédiction envoyée:', prediction);
        }
    }

    function sendCellsDetected(cells) {
        if (!cells || cells.length === 0) return;

        ENGINE.metrics.cellsFound = cells.length;

        sendToBackground({
            type: 'CELLS_DETECTED',
            payload: {
                cells,
                appleCells: cells.filter(cell => cell.type === 'apple_cell'),
                bittenCells: cells.filter(cell => cell.type === 'apple_bited_cell'),
                platform: ENGINE.platform,
                tabId: ENGINE.tabId,
                round: ENGINE.currentRound,
                metrics: { ...ENGINE.metrics }
            }
        });
    }

    function sendAnalysis(data) {
        ENGINE.metrics.roundsAnalyzed++;
        
        sendToBackground({
            type: 'ANALYSIS_RESULT',
            payload: {
                ...data,
                platform: ENGINE.platform,
                tabId: ENGINE.tabId,
                metrics: { ...ENGINE.metrics }
            }
        });
    }

    // ==========================================
    // API PUBLIQUE POUR analyzer/detector/predictor
    // ==========================================

    window.__engine = {
        sendToBackground,
        sendAnalysis,
        sendCellsDetected,
        sendPrediction,
        getState: () => ({ ...ENGINE.state }),
        getMetrics: () => ({ ...ENGINE.metrics }),
        getConfig: () => ({ ...ENGINE.config }),
        getPlatform: () => ENGINE.platform
    };

    // ==========================================
    // DÉMARRAGE
    // ==========================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
