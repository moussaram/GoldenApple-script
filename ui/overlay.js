/**
 * GoldenApple — interface et marqueurs visuels intégrés à la page du jeu.
 * Les signaux sont ancrés sur des éléments DOM réels et des positions validées.
 */
(function () {
  'use strict';
  if (window.GoldenAppleOverlay) return;

  class GoldenAppleOverlay {
    constructor(options = {}) {
      this.onAnalyze = options.onAnalyze || (() => {});
      this.onRefresh = options.onRefresh || (() => {});
      this.root = null;
      this.shadow = null;
      this.panel = null;
      this.markerLayer = null;
      this.markers = new Map();
      this.detectedCells = [];
      this.analysis = null;
      this.prediction = null;
      this.visible = true;
      this.running = false;
      this.gameDetected = false;
      this.paused = false;
      this.isTopFrame = window.top === window;
      this.animationFrame = null;
      this.create();
    }

    create() {
      if (this.root || !document.documentElement) return;
      this.root = document.createElement('div');
      this.root.id = 'goldenapple-overlay-root';
      Object.assign(this.root.style, {
        position: 'fixed', inset: '0', width: '100%', height: '100%',
        zIndex: '2147483646', pointerEvents: 'none'
      });
      this.shadow = this.root.attachShadow({ mode: 'open' });
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = chrome.runtime.getURL('ui/overlay.css');
      this.shadow.appendChild(css);

      const template = document.createElement('template');
      template.innerHTML =
        '<section class="ga-panel" id="ga-panel" aria-label="GoldenApple">' +
          '<header class="ga-header" id="ga-drag">' +
            '<div class="ga-brand"><span class="ga-logo">G</span>' +
              '<div><strong>GoldenApple</strong><small>Apple of Fortune</small></div></div>' +
            '<button class="ga-minimize" id="ga-minimize" aria-label="Réduire">−</button>' +
          '</header>' +
          '<div class="ga-body" id="ga-body">' +
            '<div class="ga-status"><span class="ga-indicator" id="ga-indicator"></span>' +
              '<span id="ga-status-text">Recherche du jeu...</span></div>' +
            '<div class="ga-info">' +
              '<div><small>Plateforme</small><strong id="ga-platform">Détection...</strong></div>' +
              '<div><small>Cellules détectées</small><strong id="ga-count">0</strong></div>' +
            '</div>' +
            '<div class="ga-actions">' +
              '<button id="ga-analyze" class="ga-primary" disabled>ANALYSER</button>' +
              '<button id="ga-refresh" class="ga-secondary">ACTUALISER</button>' +
              '<button id="ga-signals" class="ga-secondary">MASQUER LES SIGNAUX</button>' +
            '</div>' +
            '<div class="ga-legend">' +
              '<span><i class="ga-dot green"></i> Recommandation favorable / pomme détectée</span>' +
              '<span><i class="ga-dot red"></i> Cellule défavorable détectée</span>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<div class="ga-marker-layer" id="ga-marker-layer"></div>';
      this.shadow.appendChild(template.content.cloneNode(true));
      document.documentElement.appendChild(this.root);
      this.panel = this.shadow.getElementById('ga-panel');
      this.markerLayer = this.shadow.getElementById('ga-marker-layer');
      // Le moteur reste actif dans chaque frame, mais un seul panneau de contrôle
      // est affiché dans le document supérieur. Chaque frame garde ses marqueurs locaux.
      if (!this.isTopFrame && this.panel) this.panel.style.display = 'none';
      this.bindEvents();
      window.addEventListener('scroll', () => this.updatePositions(), true);
      window.addEventListener('resize', () => this.updatePositions());
      this.startPositionLoop();
    }

    bindEvents() {
      const get = id => this.shadow.getElementById(id);
      get('ga-analyze').addEventListener('click', () => {
        if (this.gameDetected && !this.running) this.onAnalyze();
      });
      get('ga-refresh').addEventListener('click', () => this.onRefresh());
      get('ga-signals').addEventListener('click', () => {
        this.visible = !this.visible;
        this.markerLayer.style.display = this.visible ? 'block' : 'none';
        get('ga-signals').textContent = this.visible ? 'MASQUER LES SIGNAUX' : 'AFFICHER LES SIGNAUX';
        if (this.visible) {
          this.updatePositions();
          this.startPositionLoop();
        }
      });
      get('ga-minimize').addEventListener('click', () => {
        const body = get('ga-body');
        const minimized = body.style.display === 'none';
        body.style.display = minimized ? 'block' : 'none';
        get('ga-minimize').textContent = minimized ? '−' : '+';
      });

      const header = get('ga-drag');
      let x = 0, y = 0, dragging = false;
      header.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        dragging = true; x = event.clientX; y = event.clientY;
        header.setPointerCapture(event.pointerId);
      });
      header.addEventListener('pointermove', event => {
        if (!dragging) return;
        const dx = event.clientX - x, dy = event.clientY - y;
        const left = parseFloat(this.panel.style.left) || 12;
        const top = parseFloat(this.panel.style.top) || 12;
        this.panel.style.left = Math.max(0, Math.min(innerWidth - 90, left + dx)) + 'px';
        this.panel.style.top = Math.max(0, Math.min(innerHeight - 60, top + dy)) + 'px';
        x = event.clientX; y = event.clientY;
      });
      header.addEventListener('pointerup', () => { dragging = false; });
      header.addEventListener('pointercancel', () => { dragging = false; });
    }

    setPlatform(platform) {
      const node = this.shadow?.getElementById('ga-platform');
      if (node) node.textContent = platform || 'Inconnue';
    }

    setStatus(message, state = 'searching') {
      const text = this.shadow?.getElementById('ga-status-text');
      const indicator = this.shadow?.getElementById('ga-indicator');
      if (text) text.textContent = message;
      if (indicator) indicator.className = 'ga-indicator ' + state;
      this.gameDetected = state === 'ready' || state === 'running';
      const button = this.shadow?.getElementById('ga-analyze');
      if (button) button.disabled = !this.gameDetected || this.running;
    }

    setDetectedCells(cells) {
      this.detectedCells = Array.isArray(cells) ? cells : [];
      const count = this.shadow?.getElementById('ga-count');
      const markable = this.detectedCells.filter(cell => this.isMarkableCell(cell));
      if (count) count.textContent = String(markable.length);
      if (this.running) this.setStatus('Analyse en cours...', 'running');
      else if (markable.length) this.setStatus('GoldenApple actif — Jeu détecté', 'ready');
      else if (this.detectedCells.length) this.setStatus('Éléments repérés — grille à confirmer', 'searching');
      else this.setStatus('Recherche des éléments du jeu...', 'searching');
      this.renderMarkers();
    }

    setAnalysis(analysis) {
      this.analysis = analysis || null;
      this.renderMarkers();
    }

    setPrediction(prediction) {
      this.prediction = prediction || null;
      this.renderMarkers();
    }

    setRunning(running) {
      this.running = Boolean(running);
      if (this.running) this.setStatus('Analyse en cours...', 'running');
      else if (this.paused) this.setStatus('Moteur en pause', 'paused');
      else {
        const count = this.detectedCells.filter(cell => this.isMarkableCell(cell)).length;
        if (count) this.setStatus('GoldenApple actif — Jeu détecté', 'ready');
        else this.setStatus('Recherche des éléments du jeu...', 'searching');
      }
    }

    setPaused(paused) {
      this.paused = Boolean(paused);
      if (!this.running) {
        if (this.paused) this.setStatus('Moteur en pause', 'paused');
        else {
          const count = this.detectedCells.filter(cell => this.isMarkableCell(cell)).length;
          this.setStatus(count ? 'GoldenApple actif — Jeu détecté' : 'Recherche des éléments du jeu...', count ? 'ready' : 'searching');
        }
      }
    }

    isMarkableCell(cell) {
      if (!cell) return false;
      const el = cell.elementRef;
      const pos = cell.gridPosition;
      if (!el || el.nodeType !== 1 || !el.isConnected || el.ownerDocument !== document) return false;
      if (!pos || !Number.isInteger(cell.row) || cell.row < 0 ||
          !Number.isInteger(cell.col) || cell.col < 0) return false;
      if (pos.method === 'data-attr' || pos.method === 'css-grid') return true;
      if (pos.method !== 'index' || !Number.isInteger(pos.index) || pos.index < 0) return false;

      // Ne pas accepter l'index si le Detector a utilisé son fallback 5 colonnes.
      const parent = el.parentElement;
      if (!parent) return false;
      const style = getComputedStyle(parent);
      const template = style.gridTemplateColumns;
      if (template && template !== 'none') {
        const columns = template.trim().split(/\s+/).length;
        return columns > 0 && pos.row === Math.floor(pos.index / columns) && pos.col === pos.index % columns;
      }
      const first = parent.firstElementChild;
      if (first) {
        const parentWidth = parent.getBoundingClientRect().width;
        const childWidth = first.getBoundingClientRect().width;
        if (parentWidth > 0 && childWidth > 0) {
          const columns = Math.round(parentWidth / childWidth);
          return columns > 0 && pos.row === Math.floor(pos.index / columns) && pos.col === pos.index % columns;
        }
      }
      return false;
    }

    findDomCell(row, col) {
      return this.detectedCells.find(cell =>
        this.isMarkableCell(cell) && cell.row === row && cell.col === col
      ) || null;
    }

    renderMarkers() {
      if (!this.markerLayer) return;
      const desired = new Map();
      const add = (row, col, color, title, priority) => {
        if (!Number.isInteger(row) || !Number.isInteger(col)) return;
        const cell = this.findDomCell(row, col);
        if (!cell) return;
        const el = cell.elementRef;
        const current = desired.get(el);
        if (!current || priority > current.priority) desired.set(el, { color, title, priority, expiresAt: 0 });
      };

      for (const cell of (this.analysis?.appleCells || [])) {
        add(cell.row, cell.col, 'green', 'Pomme identifiée par Analyzer', 2);
      }
      for (const cell of (this.analysis?.bittenCells || [])) {
        add(cell.row, cell.col, 'red', 'Cellule défavorable identifiée par Analyzer', 3);
      }

      const prediction = this.prediction;
      if (prediction && (!prediction.validUntil || prediction.validUntil >= Date.now())) {
        for (const cell of (prediction.recommendedCells || [])) {
          add(cell.row, cell.col, 'green', 'Recommandation favorable du Predictor', 1);
          const target = this.findDomCell(cell.row, cell.col);
          if (target) {
            const current = desired.get(target.elementRef);
            if (current && current.title === 'Recommandation favorable du Predictor') {
              current.expiresAt = prediction.validUntil || 0;
            }
          }
        }
      }

      const active = new Set();
      for (const [element, spec] of desired) {
        active.add(element);
        let marker = this.markers.get(element);
        if (!marker) {
          marker = document.createElement('div');
          marker.className = 'ga-cell-marker';
          marker.appendChild(document.createElement('span'));
          this.markerLayer.appendChild(marker);
          this.markers.set(element, marker);
        }
        marker.firstElementChild.className = 'ga-dot ' + spec.color;
        marker.title = spec.title;
        marker._target = element;
        marker._expiresAt = spec.expiresAt || 0;
      }
      for (const [element, marker] of this.markers) {
        if (!active.has(element) || !element.isConnected) {
          marker.remove();
          this.markers.delete(element);
        }
      }
      this.updatePositions();
    }

    updatePositions() {
      if (!this.markerLayer || !this.visible) return;
      for (const [element, marker] of this.markers) {
        if (marker._expiresAt && marker._expiresAt < Date.now()) {
          marker.remove();
          this.markers.delete(element);
          continue;
        }
        const target = marker._target;
        if (!target || !target.isConnected || target.ownerDocument !== document) {
          marker.style.display = 'none';
          continue;
        }
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 ||
            rect.bottom <= 0 || rect.right <= 0 ||
            rect.top >= innerHeight || rect.left >= innerWidth) {
          marker.style.display = 'none';
          continue;
        }
        marker.style.display = 'flex';
        marker.style.left = (rect.left + rect.width / 2) + 'px';
        marker.style.top = (rect.top + rect.height / 2) + 'px';
      }
    }

    startPositionLoop() {
      if (this.animationFrame || !this.root) return;
      const loop = () => {
        if (!this.root || !this.visible) {
          this.animationFrame = null;
          return;
        }
        this.updatePositions();
        this.animationFrame = requestAnimationFrame(loop);
      };
      this.animationFrame = requestAnimationFrame(loop);
    }

    clearMarkers() {
      for (const marker of this.markers.values()) marker.remove();
      this.markers.clear();
    }

    destroy() {
      if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      this.clearMarkers();
      this.root?.remove();
      this.root = null;
      this.shadow = null;
      this.panel = null;
      this.markerLayer = null;
    }
  }

  window.GoldenAppleOverlay = GoldenAppleOverlay;
})();