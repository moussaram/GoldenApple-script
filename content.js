// content.js — moteur original GoldenApple avec interface et signaux intégrés
(function () {
  'use strict';
  if (window.__GOLDENAPPLE_INITIALIZED__) return;
  window.__GOLDENAPPLE_INITIALIZED__ = true;

  const ENGINE = {
    initialized: false,
    state: 'idle',
    platform: null,
    tabId: null,
    currentRound: null,
    modules: { analyzer: null, detector: null, predictor: null },
    overlay: null,
    config: { scanInterval: 200, confidenceThreshold: 0.6, autoAnalyze: true, debug: false },
    metrics: { startTime: null, roundsAnalyzed: 0, cellsFound: 0, predictionsMade: 0 },
    cycleTimer: null,
    observer: null,
    manualAnalysis: false,
    lastDetectedCells: [],
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
        document.querySelector('[class*="apple-fortune" i], [class*="apple_of_fortune" i], .game-apple')) return 'generic_apple';
    return 'unknown';
  }

  function getTabId() {
    try { const url = new URL(location.href); return url.pathname + url.search; }
    catch (_) { return 'unknown'; }
  }

  function normalizeDetectedCells(cells) {
    if (!Array.isArray(cells)) return [];
    const detector = ENGINE.modules.detector;
    return cells.map(cell => {
      if (!cell || cell.elementRef) return cell;
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

  function linkModules() {
    const { analyzer, detector, predictor } = ENGINE.modules;
    detector.onDetect = cells => {
      // Ignorer un callback de scan arrivé après STOP, sauf analyse manuelle demandée.
      if (ENGINE.state === 'paused' && !ENGINE.manualAnalysis) return;
      const safeCells = normalizeDetectedCells(cells);
      ENGINE.lastDetectedCells = safeCells;
      ENGINE.metrics.cellsFound = safeCells.length;
      ENGINE.lastAnalysis = null;
      ENGINE.lastPrediction = null;
      ENGINE.overlay?.setDetectedCells(safeCells);
      ENGINE.overlay?.setAnalysis(null);
      ENGINE.overlay?.setPrediction(null);
      sendCellsDetected(safeCells);
      analyzer.feedCells(safeCells);
    };

    analyzer.onAnalyze = analysis => {
      ENGINE.lastAnalysis = analysis;
      ENGINE.metrics.roundsAnalyzed++;
      predictor.feedAnalysis(analysis);
      ENGINE.overlay?.setAnalysis(analysis);
    };

    predictor.onPredict = prediction => {
      ENGINE.lastPrediction = prediction;
      ENGINE.metrics.predictionsMade++;
      ENGINE.overlay?.setPrediction(prediction);
      sendPrediction(prediction);
    };

    detector.onDetectComplete = () => {
      // Un scan différé ne doit pas relancer l'analyse après une mise en pause.
      if (ENGINE.state === 'paused' && !ENGINE.manualAnalysis) return;
      if (!ENGINE.manualAnalysis && ENGINE.config.autoAnalyze && analyzer.hasData()) {
        const analysis = analyzer.runAnalysis();
        if (analysis) ENGINE.overlay?.setAnalysis(analysis);
      }
    };
  }

  function syncOverlayDetection(cells) {
    const safeCells = normalizeDetectedCells(Array.isArray(cells) ? cells : []);
    if (!safeCells.length) {
      if (ENGINE.lastDetectedCells.length) {
        ENGINE.lastDetectedCells = [];
        ENGINE.overlay?.setDetectedCells([]);
        ENGINE.overlay?.setAnalysis(null);
        ENGINE.overlay?.setPrediction(null);
      }
      return;
    }
    const previous = ENGINE.lastDetectedCells;
    const changed = safeCells.length !== previous.length ||
      safeCells.some(cell => !previous.some(old =>
        old.elementRef === cell.elementRef && old.row === cell.row &&
        old.col === cell.col && old.type === cell.type
      ));
    if (changed) {
      // La grille DOM a changé : ne jamais conserver des signaux attachés à l'ancienne grille.
      ENGINE.lastDetectedCells = safeCells;
      ENGINE.lastAnalysis = null;
      ENGINE.lastPrediction = null;
      ENGINE.overlay?.setDetectedCells(safeCells);
      ENGINE.overlay?.setAnalysis(null);
      ENGINE.overlay?.setPrediction(null);
    }
  }

  function refreshScan() {
    const detector = ENGINE.modules.detector;
    if (!detector) return [];
    try {
      const cells = detector.forceScan();
      if (!Array.isArray(cells) || !cells.length) {
        ENGINE.lastDetectedCells = [];
        ENGINE.overlay?.setDetectedCells([]);
        ENGINE.overlay?.setAnalysis(null);
        ENGINE.overlay?.setPrediction(null);
      }
      return Array.isArray(cells) ? cells : [];
    } catch (error) {
      console.error('[GoldenApple] Actualisation impossible:', error);
      ENGINE.overlay?.setStatus('Erreur pendant la détection', 'error');
      return [];
    }
  }

  function runManualAnalysis() {
    if (!ENGINE.initialized || ENGINE.state === 'analyzing') return;
    const wasPaused = ENGINE.state === 'paused';
    ENGINE.state = 'analyzing';
    ENGINE.overlay?.setRunning(true);
    try {
      ENGINE.manualAnalysis = true;
      const cells = ENGINE.modules.detector.forceScan();
      ENGINE.manualAnalysis = false;
      if (!Array.isArray(cells) || !cells.length || !ENGINE.modules.analyzer.hasData()) {
        ENGINE.state = wasPaused ? 'paused' : 'scanning';
        ENGINE.overlay?.setRunning(false);
        ENGINE.overlay?.setStatus(
          wasPaused ? 'Moteur en pause — aucune grille exploitable' : 'Aucune grille exploitable détectée',
          wasPaused ? 'paused' : 'searching'
        );
        return;
      }
      const result = ENGINE.modules.analyzer.runAnalysis();
      if (!result) {
        ENGINE.state = wasPaused ? 'paused' : 'scanning';
        ENGINE.overlay?.setRunning(false);
        ENGINE.overlay?.setStatus(
          wasPaused ? 'Moteur en pause — analyse impossible' : 'Analyse impossible — grille incomplète',
          wasPaused ? 'paused' : 'searching'
        );
        return;
      }
      ENGINE.state = wasPaused ? 'paused' : 'scanning';
      ENGINE.overlay?.setRunning(false);
      ENGINE.overlay?.setStatus(
        wasPaused ? 'Analyse terminée — moteur en pause' : 'Analyse terminée — GoldenApple actif',
        wasPaused ? 'paused' : 'ready'
      );
    } catch (error) {
      ENGINE.manualAnalysis = false;
      ENGINE.state = wasPaused ? 'paused' : 'scanning';
      ENGINE.overlay?.setRunning(false);
      ENGINE.overlay?.setStatus('Erreur pendant l’analyse', 'error');
      console.error('[GoldenApple] Analyse manuelle:', error);
    }
  }

  function startAnalysisCycle() {
    if (ENGINE.state === 'paused' || ENGINE.cycleTimer) return;
    ENGINE.state = 'scanning';
    ENGINE.overlay?.setPaused?.(false);
    const cycle = () => {
      if (ENGINE.state === 'paused') { ENGINE.cycleTimer = null; return; }
      try {
        const cells = ENGINE.modules.detector.scan();
        syncOverlayDetection(cells);
      } catch (error) {
        console.error('[GoldenApple] Scan automatique:', error);
      }
      ENGINE.cycleTimer = setTimeout(cycle, ENGINE.config.scanInterval);
    };
    cycle();
  }

  function stopAnalysisCycle() {
    if (ENGINE.cycleTimer) clearTimeout(ENGINE.cycleTimer);
    ENGINE.cycleTimer = null;
    // Annuler aussi le scan différé déclenché par le MutationObserver.
    const detector = ENGINE.modules.detector;
    if (detector?.scanTimer) {
      clearTimeout(detector.scanTimer);
      detector.scanTimer = null;
    }
    ENGINE.state = 'paused';
    ENGINE.overlay?.setPaused?.(true);
  }

  function handleCommand(command, params) {
    switch (command) {
      case 'START_ANALYSIS': runManualAnalysis(); break;
      case 'STOP_ANALYSIS': stopAnalysisCycle(); break;
      case 'RESUME_ANALYSIS': ENGINE.state = 'scanning'; startAnalysisCycle(); break;
      case 'FORCE_SCAN': refreshScan(); break;
      case 'SET_CONFIG': if (params) Object.assign(ENGINE.config, params); break;
      case 'RESET':
        ENGINE.metrics = { startTime: Date.now(), roundsAnalyzed: 0, cellsFound: 0, predictionsMade: 0 };
        ENGINE.lastAnalysis = null;
        ENGINE.lastPrediction = null;
        ENGINE.modules.predictor.reset();
        ENGINE.modules.analyzer.reset();
        ENGINE.overlay?.setAnalysis(null);
        ENGINE.overlay?.setPrediction(null);
        break;
    }
  }

  function listenBackgroundCommands() {
    if (!chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message?.type) {
        case 'ENGINE_COMMAND':
          handleCommand(message.command, message.params);
          sendResponse?.({ received: true, state: ENGINE.state });
          break;
        case 'TAB_CHANGED':
          if (message.platform) {
            ENGINE.platform = message.platform;
            ENGINE.overlay?.setPlatform(message.platform);
          }
          sendResponse?.({ received: true });
          break;
        case 'START_ANALYSIS': runManualAnalysis(); sendResponse?.({ received: true }); break;
        case 'STOP_ANALYSIS': stopAnalysisCycle(); sendResponse?.({ received: true }); break;
      }
      return true;
    });
  }

  function listenPageEvents() {
    ENGINE.observer = new MutationObserver(records => {
      if (ENGINE.state === 'paused') return;
      const overlayRoot = document.getElementById('goldenapple-overlay-root');
      const pageChanged = records.some(record => {
        const target = record.target;
        if (overlayRoot && (target === overlayRoot || overlayRoot.contains(target))) return false;
        return true;
      });
      if (pageChanged) ENGINE.modules.detector.scheduleScan();
    });
    if (document.documentElement) {
      ENGINE.observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'data-state', 'data-cell']
      });
    }
    document.addEventListener('click', event => {
      if (ENGINE.state === 'paused') return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const cell = target.closest('[class*="apple" i], [class*="cell" i], [class*="grid" i], [class*="tile" i], [role="button"]');
      if (cell) {
        try { ENGINE.modules.detector.handleUserClick(cell); }
        catch (error) { console.warn('[GoldenApple] Suivi du clic impossible:', error); }
      }
    }, true);
  }

  function sendToBackground(message) {
    try {
      if (chrome?.runtime?.sendMessage) {
        const pending = chrome.runtime.sendMessage(message);
        if (pending?.catch) pending.catch(() => {});
      }
    } catch (_) {
      // L'interface locale continue même si le background n'est pas disponible.
    }
  }

  function sendPrediction(prediction) {
    sendToBackground({
      type: 'PREDICTION_READY',
      payload: { ...prediction, platform: ENGINE.platform, tabId: ENGINE.tabId,
        round: ENGINE.currentRound, metrics: { ...ENGINE.metrics } }
    });
  }

  function sendCellsDetected(cells) {
    if (!cells || !cells.length) return;
    // Les références DOM servent uniquement à l'overlay local : elles ne sont
    // ni clonables ni utiles au service worker Chrome.
    const serializableCells = cells.map(cell => {
      if (!cell || typeof cell !== 'object') return cell;
      const { elementRef, ...data } = cell;
      return data;
    });
    sendToBackground({
      type: 'CELLS_DETECTED',
      payload: {
        cells: serializableCells,
        appleCells: serializableCells.filter(cell => cell?.type === 'apple_cell'),
        bittenCells: serializableCells.filter(cell => cell?.type === 'apple_bited_cell'),
        platform: ENGINE.platform, tabId: ENGINE.tabId,
        round: ENGINE.currentRound, metrics: { ...ENGINE.metrics }
      }
    });
  }

  function sendAnalysis(data) {
    sendToBackground({
      type: 'ANALYSIS_RESULT',
      payload: { ...data, platform: ENGINE.platform, tabId: ENGINE.tabId, metrics: { ...ENGINE.metrics } }
    });
  }

  window.__engine = {
    sendToBackground, sendAnalysis, sendCellsDetected, sendPrediction,
    getState: () => ENGINE.state,
    getMetrics: () => ({ ...ENGINE.metrics }),
    getConfig: () => ({ ...ENGINE.config }),
    getPlatform: () => ENGINE.platform
  };

  function init() {
    if (ENGINE.initialized) return;
    const missing = [];
    if (typeof AppleAnalyzer !== 'function') missing.push('AppleAnalyzer');
    if (typeof AppleDetector !== 'function') missing.push('AppleDetector');
    if (typeof ApplePredictor !== 'function') missing.push('ApplePredictor');
    if (typeof window.GoldenAppleOverlay !== 'function') missing.push('GoldenAppleOverlay');
    if (missing.length) {
      console.error('[GoldenApple] Modules indisponibles:', missing);
      return;
    }

    ENGINE.metrics.startTime = Date.now();
    ENGINE.platform = detectPlatform();
    ENGINE.tabId = getTabId();
    ENGINE.modules.analyzer = new AppleAnalyzer(ENGINE);
    ENGINE.modules.detector = new AppleDetector(ENGINE);
    ENGINE.modules.predictor = new ApplePredictor(ENGINE);
    ENGINE.overlay = new window.GoldenAppleOverlay({
      onAnalyze: runManualAnalysis,
      onRefresh: refreshScan
    });
    ENGINE.overlay.setPlatform(ENGINE.platform);

    linkModules();
    listenBackgroundCommands();
    listenPageEvents();
    ENGINE.initialized = true;
    ENGINE.state = 'scanning';
    ENGINE.overlay.setStatus('Recherche des éléments du jeu...', 'searching');

    sendToBackground({
      type: 'ENGINE_STATUS',
      payload: { state: ENGINE.state, platform: ENGINE.platform, tabId: ENGINE.tabId, version: '2.1.0' }
    });

    startAnalysisCycle();
    refreshScan();

    window.GoldenAppleEngine = {
      analyze: runManualAnalysis, refresh: refreshScan,
      pause: stopAnalysisCycle, resume: startAnalysisCycle,
      getState: () => ENGINE.state,
      getPlatform: () => ENGINE.platform,
      getMetrics: () => ({ ...ENGINE.metrics }),
      getLastAnalysis: () => ENGINE.lastAnalysis,
      getLastPrediction: () => ENGINE.lastPrediction
    };
    console.log('[GoldenApple] Interface locale initialisée sur', ENGINE.platform);
  }

  function boot() {
    if (document.documentElement) init();
    else requestAnimationFrame(boot);
  }
  boot();
})();