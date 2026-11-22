// content.js — contrôleur local GoldenApple pour Kiwi Browser
// Raccorde les moteurs existants à l'overlay sans backend ni application externe.
(function () {
  'use strict';

  if (window.__GOLDENAPPLE_INITIALIZED__) return;
  window.__GOLDENAPPLE_INITIALIZED__ = true;

  const ENGINE = {
    initialized: false,
    state: 'initializing',
    platform: 'unknown',
    modules: { analyzer: null, detector: null, predictor: null },
    overlay: null,
    config: {
      scanInterval: 500,
      confidenceThreshold: 0.6,
      autoAnalyze: false,
      debug: false
    },
    metrics: {
      startTime: Date.now(),
      roundsAnalyzed: 0,
      cellsFound: 0,
      predictionsMade: 0
    },
    cycleTimer: null,
    lastAnalysis: null,
    lastPrediction: null
  };

  function detectPlatform() {
    const hostname = location.hostname.toLowerCase();
    if (hostname.includes('1xbet')) return '1xbet';
    if (hostname.includes('melbet')) return 'melbet';
    if (hostname.includes('winwin')) return 'winwin';
    if (hostname.includes('megapari')) return 'megapari';
    if (hostname.includes('1xgame')) return '1xgame';
    if (hostname.includes('1xslot')) return '1xslot';
    if (location.pathname.toLowerCase().includes('apple-of-fortune') ||
        document.querySelector('[class*="apple-fortune" i], [class*="apple_of_fortune" i], .game-apple')) {
      return 'generic_apple';
    }
    return 'unknown';
  }

  function wrapCallback(target, property, callback) {
    const previous = target[property];
    target[property] = function (...args) {
      if (typeof previous === 'function') {
        try { previous.apply(this, args); }
        catch (error) { console.warn('[GoldenApple] Callback précédent en erreur:', error); }
      }
      callback(...args);
    };
  }

  function normalizeDetectedCells(cells) {
    if (!Array.isArray(cells)) return [];
    const detector = ENGINE.modules.detector;
    return cells.map(cell => {
      if (!cell || cell.elementRef) return cell;
      // handleUserClick() expose une analyse sans elementRef ; le Detector
      // conserve la référence dans revealedCells. On la récupère sans toucher
      // à son algorithme ni à ses sélecteurs.
      if (detector?.revealedCells instanceof Map) {
        for (const [element, analysis] of detector.revealedCells.entries()) {
          if (analysis === cell && element?.isConnected && element.ownerDocument === document) {
            return { ...cell, elementRef: element };
          }
        }
      }
      return cell;
    });
  }

  function handleDetectedCells(cells) {
    const safeCells = normalizeDetectedCells(cells);
    ENGINE.metrics.cellsFound = safeCells.length;
    ENGINE.overlay?.setCells(safeCells);
    ENGINE.modules.analyzer?.feedCells(safeCells);
  }

  function handleAnalysis(result) {
    if (!result) return;
    ENGINE.metrics.roundsAnalyzed++;
    ENGINE.lastAnalysis = result;
  }

  function handlePrediction(result) {
    if (!result) return;
    ENGINE.metrics.predictionsMade++;
    ENGINE.lastPrediction = result;
    // Les recommandations du Predictor restent des données statistiques :
    // elles ne sont jamais converties en marqueurs d'observation.
  }

  function connectExistingCallbacks() {
    const { detector, analyzer, predictor } = ENGINE.modules;
    wrapCallback(detector, 'onDetect', handleDetectedCells);
    wrapCallback(analyzer, 'onAnalyze', result => {
      handleAnalysis(result);
      predictor.feedAnalysis(result);
    });
    wrapCallback(predictor, 'onPredict', handlePrediction);
  }

  function scheduleNextScan() {
    if (ENGINE.state === 'paused' || !ENGINE.initialized) return;
    clearTimeout(ENGINE.cycleTimer);
    ENGINE.cycleTimer = setTimeout(() => {
      if (ENGINE.state !== 'paused') {
        try {
          const cells = ENGINE.modules.detector.scan();
          if (Array.isArray(cells) && cells.length === 0) ENGINE.overlay.setCells([]);
        } catch (error) { reportError('Erreur pendant la détection', error); }
        scheduleNextScan();
      }
    }, ENGINE.config.scanInterval);
  }

  function refreshDetection() {
    const detector = ENGINE.modules.detector;
    if (!detector) return [];
    try {
      const cells = detector.forceScan();
      if (Array.isArray(cells) && cells.length) handleDetectedCells(cells);
      else ENGINE.overlay.setCells([]);
      return Array.isArray(cells) ? cells : [];
    } catch (error) {
      reportError('Impossible d’actualiser la détection', error);
      return [];
    }
  }

  function startAnalysis() {
    if (!ENGINE.initialized || ENGINE.state === 'analyzing' || ENGINE.state === 'paused') return;
    ENGINE.state = 'analyzing';
    ENGINE.overlay.setRunning(true);
    try {
      const cells = refreshDetection();
      if (cells.length) ENGINE.modules.analyzer.feedCells(normalizeDetectedCells(cells));
      if (!ENGINE.modules.analyzer.hasData()) {
        ENGINE.state = 'searching';
        ENGINE.overlay.setRunning(false);
        ENGINE.overlay.setStatus('Aucune grille exploitable détectée', 'searching');
        return;
      }
      const result = ENGINE.modules.analyzer.runAnalysis();
      if (!result) {
        ENGINE.state = 'searching';
        ENGINE.overlay.setRunning(false);
        ENGINE.overlay.setStatus('Analyse impossible — grille incomplète', 'searching');
        return;
      }
      ENGINE.state = 'ready';
      ENGINE.overlay.setRunning(false);
      ENGINE.overlay.setStatus('Analyse terminée', 'ready');
      if (ENGINE.config.debug) console.log('[GoldenApple] Analyse locale terminée', result);
    } catch (error) {
      ENGINE.state = 'error';
      ENGINE.overlay.setRunning(false);
      reportError('Erreur pendant l’analyse', error);
    }
  }

  function pauseAnalysis() {
    if (ENGINE.state === 'paused') return;
    ENGINE.state = 'paused';
    clearTimeout(ENGINE.cycleTimer);
    ENGINE.cycleTimer = null;
    ENGINE.overlay.setRunning(false);
    ENGINE.overlay.setPaused(true);
    ENGINE.overlay.setStatus('Analyse en pause', 'paused');
  }

  function resumeAnalysis() {
    if (ENGINE.state !== 'paused') return;
    ENGINE.state = 'searching';
    ENGINE.overlay.setRunning(false);
    ENGINE.overlay.setPaused(false);
    refreshDetection();
    scheduleNextScan();
  }

  function reportError(message, error) {
    console.error('[GoldenApple]', message, error);
    ENGINE.overlay?.setRunning(false);
    ENGINE.overlay?.setStatus(message, 'error');
  }

  function init() {
    if (ENGINE.initialized) return;

    const required = ['AppleAnalyzer', 'AppleDetector', 'ApplePredictor', 'GoldenAppleOverlay'];
    const missing = required.filter(name => typeof window[name] !== 'function');
    if (missing.length) {
      console.error('[GoldenApple] Modules indisponibles :', missing);
      return;
    }

    ENGINE.platform = detectPlatform();
    try {
      // Signatures vérifiées dans les fichiers réels : chaque constructeur reçoit ENGINE.
      ENGINE.modules.analyzer = new window.AppleAnalyzer(ENGINE);
      ENGINE.modules.detector = new window.AppleDetector(ENGINE);
      ENGINE.modules.predictor = new window.ApplePredictor(ENGINE);

      ENGINE.overlay = new window.GoldenAppleOverlay({
        onAnalyze: startAnalysis,
        onRefresh: refreshDetection,
        onPause: pauseAnalysis,
        onResume: resumeAnalysis
      });
      ENGINE.overlay.setPlatform(ENGINE.platform);

      connectExistingCallbacks();
      ENGINE.initialized = true;
      ENGINE.state = 'searching';
      ENGINE.overlay.setStatus('Recherche des éléments du jeu...', 'searching');

      refreshDetection();
      scheduleNextScan();

      window.GoldenAppleEngine = {
        start: startAnalysis,
        pause: pauseAnalysis,
        resume: resumeAnalysis,
        refresh: refreshDetection,
        getState: () => ENGINE.state,
        getPlatform: () => ENGINE.platform,
        getMetrics: () => ({ ...ENGINE.metrics }),
        getLastAnalysis: () => ENGINE.lastAnalysis,
        getLastPrediction: () => ENGINE.lastPrediction
      };

      console.log('[GoldenApple] Moteur autonome initialisé sur', ENGINE.platform);
    } catch (error) {
      reportError('Initialisation impossible', error);
    }
  }

  function boot() {
    if (document.documentElement) init();
    else requestAnimationFrame(boot);
  }

  boot();
})();
