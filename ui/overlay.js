/**
 * GoldenApple Overlay
 * Interface locale intégrée directement dans la page du jeu.
 * Les marqueurs ne sont posés que sur des cellules DOM réelles
 * disposant d'une référence et de coordonnées de grille fiables.
 */
(function () {
  'use strict';

  if (window.GoldenAppleOverlay) return;

  class GoldenAppleOverlay {
    constructor(options = {}) {
      this.onAnalyze = options.onAnalyze || (() => {});
      this.onRefresh = options.onRefresh || (() => {});
      this.onPause = options.onPause || (() => {});
      this.onResume = options.onResume || (() => {});

      this.root = null;
      this.shadow = null;
      this.panel = null;
      this.markerLayer = null;
      this.markers = new Map();
      this.cells = [];
      this.visible = true;
      this.running = false;
      this.gameDetected = false;
      this.animationFrame = null;
      this.status = 'Recherche du jeu...';

      this.create();
    }

    create() {
      if (this.root || !document.documentElement) return;

      this.root = document.createElement('div');
      this.root.id = 'goldenapple-overlay-root';
      Object.assign(this.root.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        zIndex: '2147483646',
        pointerEvents: 'none'
      });

      this.shadow = this.root.attachShadow({ mode: 'open' });

      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = chrome.runtime.getURL('ui/overlay.css');
      this.shadow.appendChild(stylesheet);

      const template = document.createElement('template');
      template.innerHTML = `
        <div class="ga-panel" id="ga-panel">
          <div class="ga-header" id="ga-drag">
            <div class="ga-brand">
              <span class="ga-logo">G</span>
              <div>
                <strong>GoldenApple</strong>
                <small>Apple of Fortune Engine</small>
              </div>
            </div>
            <button class="ga-minimize" id="ga-minimize" aria-label="Réduire">−</button>
          </div>
          <div class="ga-body" id="ga-body">
            <div class="ga-status">
              <span class="ga-indicator" id="ga-indicator"></span>
              <span id="ga-status-text">Initialisation...</span>
            </div>
            <div class="ga-info">
              <div>
                <small>Plateforme</small>
                <strong id="ga-platform">Recherche...</strong>
              </div>
              <div>
                <small>Cellules observables</small>
                <strong id="ga-count">0</strong>
              </div>
            </div>
            <div class="ga-actions">
              <button id="ga-analyze" class="ga-primary" disabled>LANCER L'ANALYSE</button>
              <button id="ga-refresh" class="ga-secondary">ACTUALISER</button>
              <button id="ga-pause" class="ga-secondary">METTRE EN PAUSE</button>
              <button id="ga-markers" class="ga-secondary">MASQUER LES SIGNAUX</button>
            </div>
            <div class="ga-legend">
              <span><i class="ga-dot green"></i> Pomme observée par Detector</span>
              <span><i class="ga-dot red"></i> Pomme mordue observée</span>
            </div>
            <small class="ga-footer">Les recommandations statistiques ne sont pas des observations.</small>
          </div>
        </div>
        <div class="ga-marker-layer" id="ga-markers-layer"></div>
      `;

      this.shadow.appendChild(template.content.cloneNode(true));
      document.documentElement.appendChild(this.root);

      this.panel = this.shadow.getElementById('ga-panel');
      this.markerLayer = this.shadow.getElementById('ga-markers-layer');
      this.bindEvents();

      this.setStatus('Recherche du jeu...', 'searching');
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
      get('ga-pause').addEventListener('click', () => {
        if (this.running) this.onPause();
        else this.onResume();
      });
      get('ga-markers').addEventListener('click', () => {
        this.visible = !this.visible;
        this.markerLayer.style.display = this.visible ? 'block' : 'none';
        get('ga-markers').textContent = this.visible ? 'MASQUER LES SIGNAUX' : 'AFFICHER LES SIGNAUX';
        if (this.visible) this.updatePositions();
      });
      get('ga-minimize').addEventListener('click', () => {
        const body = get('ga-body');
        const minimized = body.style.display === 'none';
        body.style.display = minimized ? 'block' : 'none';
        get('ga-minimize').textContent = minimized ? '−' : '+';
      });

      const header = get('ga-drag');
      let startX = 0;
      let startY = 0;
      let dragging = false;

      header.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        header.setPointerCapture(event.pointerId);
      });
      header.addEventListener('pointermove', event => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        const left = parseFloat(this.panel.style.left) || 12;
        const top = parseFloat(this.panel.style.top) || 12;
        this.panel.style.left = `${Math.max(0, Math.min(innerWidth - 80, left + dx))}px`;
        this.panel.style.top = `${Math.max(0, Math.min(innerHeight - 50, top + dy))}px`;
        startX = event.clientX;
        startY = event.clientY;
      });
      header.addEventListener('pointerup', () => { dragging = false; });
      header.addEventListener('pointercancel', () => { dragging = false; });
    }

    setStatus(message, state = 'searching') {
      this.status = message;
      const text = this.shadow?.getElementById('ga-status-text');
      const indicator = this.shadow?.getElementById('ga-indicator');
      if (!text || !indicator) return;

      text.textContent = message;
      indicator.className = `ga-indicator ${state}`;
      this.gameDetected = state === 'ready' || state === 'running' || state === 'paused';

      const button = this.shadow.getElementById('ga-analyze');
      if (button) button.disabled = !this.gameDetected || this.running;
    }

    setPlatform(platform) {
      const element = this.shadow?.getElementById('ga-platform');
      if (element) element.textContent = platform || 'Inconnue';
    }

    setRunning(running) {
      this.running = Boolean(running);
      const button = this.shadow?.getElementById('ga-pause');
      const analyzeButton = this.shadow?.getElementById('ga-analyze');
      if (button) button.textContent = this.running ? 'METTRE EN PAUSE' : 'REPRENDRE';
      if (analyzeButton) analyzeButton.disabled = !this.gameDetected || this.running;
      if (this.running) this.setStatus('Analyse en cours...', 'running');
    }

    setCells(cells) {
      this.cells = Array.isArray(cells) ? cells : [];
      const count = this.shadow?.getElementById('ga-count');
      if (count) count.textContent = String(this.cells.filter(cell => this.isMarkableCell(cell)).length);

      const usable = this.cells.some(cell => this.isMarkableCell(cell));
      // Une nouvelle détection ne doit jamais effacer l'état d'analyse en cours.
      if (this.running) {
        this.setStatus('Analyse en cours...', 'running');
      } else if (usable) {
        this.setStatus('Jeu détecté — Prêt à analyser', 'ready');
      } else if (this.cells.length) {
        this.setStatus('Éléments détectés — Vérification', 'searching');
      } else {
        this.setStatus('Recherche des éléments du jeu...', 'searching');
      }
      this.renderMarkers();
    }

    isMarkableCell(cell) {
      if (!cell || (cell.type !== 'apple_cell' && cell.type !== 'apple_bited_cell')) return false;
      const element = cell.elementRef;
      const position = cell.gridPosition;
      if (!element || element.nodeType !== 1 || element.ownerDocument !== document || !element.isConnected) return false;
      if (!position || !['data-attr', 'index', 'css-grid'].includes(position.method)) return false;
      return Number.isInteger(cell.row) && cell.row >= 0 &&
        Number.isInteger(cell.col) && cell.col >= 0;
    }

    renderMarkers() {
      if (!this.markerLayer) return;
      const nextElements = new Set();

      for (const cell of this.cells) {
        if (!this.isMarkableCell(cell)) continue;
        const element = cell.elementRef;
        nextElements.add(element);

        let marker = this.markers.get(element);
        if (!marker) {
          marker = document.createElement('div');
          marker.className = 'ga-cell-marker';
          const dot = document.createElement('span');
          dot.className = 'ga-dot';
          marker.appendChild(dot);
          this.markerLayer.appendChild(marker);
          this.markers.set(element, marker);
        }

        marker.firstElementChild.className = `ga-dot ${cell.type === 'apple_cell' ? 'green' : 'red'}`;
        marker.title = cell.type === 'apple_cell' ? 'Pomme observée par Detector' : 'Pomme mordue observée par Detector';
        marker._target = element;
      }

      for (const [element, marker] of this.markers) {
        if (!nextElements.has(element) || !element.isConnected) {
          marker.remove();
          this.markers.delete(element);
        }
      }
      this.updatePositions();
    }

    updatePositions() {
      if (!this.markerLayer || !this.visible) return;
      for (const marker of this.markers.values()) {
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
        marker.style.left = `${rect.left + rect.width / 2}px`;
        marker.style.top = `${rect.top + rect.height / 2}px`;
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
      this.markers.forEach(marker => marker.remove());
      this.markers.clear();
      this.cells = [];
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
