// core/analyzer.js - Analyseur de grille Apple of Fortune
// Analyse les cellules détectées pour extraire:
// - apple_cell (pommes gagnantes)
// - apple_bited_cell (pommes perdantes)
// - Numéro de phase
// - Côtes/multiplicateurs par phase

class AppleAnalyzer {
    constructor(engine) {
        this.engine = engine;
        this.cells = [];
        this.phases = [];
        this.currentPhase = 0;
        this.gridHistory = [];
        this.analysisCache = null;
        this.lastAnalysisTime = 0;
        
        // Configuration des grilles par plateforme
        this.platformConfigs = {
            '1xbet': { rows: 5, cols: 5, phases: 10 },
            'melbet': { rows: 5, cols: 5, phases: 10 },
            'winwin': { rows: 5, cols: 5, phases: 8 },
            'megapari': { rows: 5, cols: 5, phases: 10 },
            '1xgame': { rows: 5, cols: 5, phases: 10 },
            'default': { rows: 5, cols: 5, phases: 10 }
        };
        
        this.onAnalyze = null; // Callback
    }

    // ==========================================
    // ALIMENTATION
    // ==========================================

    feedCells(cells) {
        if (!cells || cells.length === 0) return;
        
        this.cells = cells;
        this.detectPhase();
    }

    hasData() {
        return this.cells.length > 0;
    }

    // ==========================================
    // ANALYSE PRINCIPALE
    // ==========================================

    runAnalysis() {
        const grid = this.buildGrid();
        if (!grid || grid.length === 0) return null;

        const config = this.getPlatformConfig();
        
        const analysis = {
            timestamp: Date.now(),
            platform: this.engine.platform,
            phase: this.currentPhase,
            totalPhases: config.phases,
            
            // Cellules détectées
            appleCells: this.extractAppleCells(grid),
            bittenCells: this.extractBittenCells(grid),
            
            // Statistiques de la grille
            gridStats: this.computeGridStats(grid),
            
            // Côtes et multiplicateurs
            odds: this.extractOdds(),
            
            // Métriques de phase
            phaseMetrics: this.computePhaseMetrics(grid),
            
            // Historique
            gridHash: this.hashGrid(grid)
        };

        // Détection de nouvelle phase
        if (this.isNewPhase(analysis)) {
            this.currentPhase++;
            analysis.phase = this.currentPhase;
            analysis.newPhase = true;
        }

        // Stocker dans l'historique
        this.gridHistory.push(analysis);
        if (this.gridHistory.length > 50) {
            this.gridHistory.shift();
        }

        this.analysisCache = analysis;
        this.lastAnalysisTime = Date.now();

        // Callback
        if (this.onAnalyze) {
            this.onAnalyze(analysis);
        }

        // Envoyer au background
        if (window.__engine) {
            window.__engine.sendAnalysis(analysis);
        }

        if (this.engine.config.debug) {
            console.log(`[Analyzer] Phase ${analysis.phase}: ${analysis.appleCells.length} pommes, ${analysis.bittenCells.length} mordues`);
        }

        return analysis;
    }

    // ==========================================
    // CONSTRUCTION DE LA GRILLE
    // ==========================================

    buildGrid() {
        const config = this.getPlatformConfig();
        const { rows, cols } = config;
        
        // Créer une grille vide rows×cols
        const grid = Array.from({ length: rows }, () => 
            Array.from({ length: cols }, () => null)
        );

        // Placer les cellules détectées dans la grille
        for (const cell of this.cells) {
            const row = cell.row;
            const col = cell.col;
            
            if (row >= 0 && row < rows && col >= 0 && col < cols) {
                grid[row][col] = cell;
            }
        }

        return grid;
    }

    getPlatformConfig() {
        return this.platformConfigs[this.engine.platform] || this.platformConfigs.default;
    }

    // ==========================================
    // EXTRACTION DES CELLULES
    // ==========================================

    extractAppleCells(grid) {
        const apples = [];
        
        for (let row = 0; row < grid.length; row++) {
            for (let col = 0; col < grid[row].length; col++) {
                const cell = grid[row][col];
                if (cell && cell.type === 'apple_cell') {
                    apples.push({
                        row,
                        col,
                        phase: this.currentPhase,
                        confidence: cell.confidence || 1.0,
                        position: { row, col },
                        gridIndex: row * grid[row].length + col
                    });
                }
            }
        }

        return apples;
    }

    extractBittenCells(grid) {
        const bitten = [];
        
        for (let row = 0; row < grid.length; row++) {
            for (let col = 0; col < grid[row].length; col++) {
                const cell = grid[row][col];
                if (cell && cell.type === 'apple_bited_cell') {
                    bitten.push({
                        row,
                        col,
                        phase: this.currentPhase,
                        confidence: cell.confidence || 1.0,
                        position: { row, col },
                        gridIndex: row * grid[row].length + col
                    });
                }
            }
        }

        return bitten;
    }

    // ==========================================
    // STATISTIQUES DE GRILLE
    // ==========================================

    computeGridStats(grid) {
        let total = 0;
        let appleCount = 0;
        let bittenCount = 0;
        let emptyCount = 0;
        let unknownCount = 0;

        for (const row of grid) {
            for (const cell of row) {
                total++;
                if (!cell) {
                    emptyCount++;
                } else switch (cell.type) {
                    case 'apple_cell': appleCount++; break;
                    case 'apple_bited_cell': bittenCount++; break;
                    default: unknownCount++;
                }
            }
        }

        return {
            total,
            appleCount,
            bittenCount,
            emptyCount,
            unknownCount,
            appleRatio: total > 0 ? appleCount / total : 0,
            bittenRatio: total > 0 ? bittenCount / total : 0,
            density: total > 0 ? (appleCount + bittenCount) / total : 0
        };
    }

    // ==========================================
    // DÉTECTION DES PHASES
    // ==========================================

    detectPhase() {
        // Chercher des indicateurs de phase dans le DOM
        const phaseIndicators = [
            '[class*="phase"]',
            '[class*="level"]',
            '[class*="round"]',
            '[class*="step"]',
            '[data-phase]',
            '[data-level]',
            '[data-round]',
            '.phase-indicator',
            '.level-badge',
            '.round-counter'
        ];

        for (const selector of phaseIndicators) {
            const el = document.querySelector(selector);
            if (el) {
                const text = el.textContent || el.getAttribute('data-phase') || 
                            el.getAttribute('data-level') || el.getAttribute('data-round');
                const num = parseInt(text);
                if (!isNaN(num) && num > 0) {
                    this.currentPhase = num;
                    return;
                }
            }
        }

        // Détection par nombre de lignes révélées
        const revealedRows = this.countRevealedRows();
        if (revealedRows > 0 && revealedRows !== this.currentPhase) {
            this.currentPhase = revealedRows;
        }
    }

    countRevealedRows() {
        // Compter combien de lignes ont des cellules cliquées
        const clickedCells = this.cells.filter(c => c.clicked || c.revealed);
        const rowsRevealed = new Set(clickedCells.map(c => c.row));
        return rowsRevealed.size;
    }

    isNewPhase(analysis) {
        if (this.gridHistory.length === 0) return true;
        
        const last = this.gridHistory[this.gridHistory.length - 1];
        
        // Si le nombre de cellules a changé significativement
        const cellDelta = Math.abs(
            (analysis.appleCells.length + analysis.bittenCells.length) -
            (last.appleCells.length + last.bittenCells.length)
        );
        
        return cellDelta > 3;
    }

    // ==========================================
    // EXTRACTION DES CÔTES
    // ==========================================

    extractOdds() {
        const odds = [];

        // Chercher les multiplicateurs dans le DOM
        const oddSelectors = [
            '[class*="multiplier"]',
            '[class*="odd"]',
            '[class*="coefficient"]',
            '[class*="payout"]',
            '[class*="x"]',
            '[data-multiplier]',
            '[data-odd]',
            '.multiplier-value',
            '.odd-value',
            '.win-amount'
        ];

        for (const selector of oddSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                const text = el.textContent.trim();
                const match = text.match(/(\d+(?:\.\d+)?)\s*[xX×]/);
                if (match) {
                    odds.push({
                        value: parseFloat(match[1]),
                        source: el.className || selector,
                        text: text
                    });
                }
            }
        }

        // Chercher dans les data-attributs
        const allElements = document.querySelectorAll('[data-multiplier], [data-odd], [data-payout]');
        for (const el of allElements) {
            const val = el.getAttribute('data-multiplier') || 
                       el.getAttribute('data-odd') || 
                       el.getAttribute('data-payout');
            if (val) {
                const num = parseFloat(val);
                if (!isNaN(num)) {
                    odds.push({
                        value: num,
                        source: `${el.tagName}[${Array.from(el.attributes).find(a => a.name.startsWith('data-')).name}]`,
                        text: val
                    });
                }
            }
        }

        // Trier et dédupliquer
        const unique = [];
        const seen = new Set();
        for (const odd of odds.sort((a, b) => a.value - b.value)) {
            const key = odd.value.toFixed(2);
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(odd);
            }
        }

        return unique;
    }

    // ==========================================
    // MÉTRIQUES DE PHASE
    // ==========================================

    computePhaseMetrics(grid) {
        const stats = this.computeGridStats(grid);
        
        // Probabilité de trouver une pomme sur cette phase
        const totalRevealed = stats.appleCount + stats.bittenCount;
        const appleProbability = totalRevealed > 0 ? stats.appleCount / totalRevealed : 0;
        
        // Ratio de progression
        const config = this.getPlatformConfig();
        const progress = this.currentPhase / config.phases;

        return {
            phase: this.currentPhase,
            appleProbability,
            progress,
            cellsRemaining: stats.emptyCount,
            appleDensity: stats.appleRatio
        };
    }

    // ==========================================
    // HASH DE GRILLE
    // ==========================================

    hashGrid(grid) {
        let hash = '';
        for (const row of grid) {
            for (const cell of row) {
                if (!cell) hash += '0';
                else if (cell.type === 'apple_cell') hash += 'A';
                else if (cell.type === 'apple_bited_cell') hash += 'B';
                else hash += '?';
            }
            hash += '|';
        }
        return hash;
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    getPhase() {
        return this.currentPhase;
    }

    getLastAnalysis() {
        return this.analysisCache;
    }

    getHistory() {
        return this.gridHistory;
    }

    reset() {
        this.cells = [];
        this.phases = [];
        this.currentPhase = 0;
        this.gridHistory = [];
        this.analysisCache = null;
        this.lastAnalysisTime = 0;
    }
}

// Exporter pour le content script
window.AppleAnalyzer = AppleAnalyzer;