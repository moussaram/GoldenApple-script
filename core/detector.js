// core/detector.js - Détecteur de cellules Apple of Fortune
// Scanne le DOM et le Canvas pour trouver:
// - apple_cell: éléments représentant une pomme complète (gagnante)
// - apple_bited_cell: éléments représentant une pomme mordue (perdante)

class AppleDetector {
    constructor(engine) {
        this.engine = engine;
        this.foundCells = [];
        this.lastScanHash = null;
        this.scanTimer = null;
        this.clickedCells = new Set();
        this.revealedCells = new Map();
        
        this.onDetect = null;
        this.onDetectComplete = null;

        // Seuils de détection
        this.thresholds = {
            minCellSize: 16,
            maxCellSize: 320,
            minConfidence: 0.3,
            colorDistance: 30
        };

        // Patterns de couleur pour les pommes
        this.appleColorProfiles = {
            // Pomme complète (rouge vif, vert)
            apple_cell: {
                primary: { r: [180, 255], g: [40, 120], b: [30, 100] },     // Rouge vif
                secondary: { r: [50, 120], g: [160, 230], b: [40, 100] },    // Vert
                golden: { r: [200, 255], g: [160, 220], b: [40, 100] }       // Doré
            },
            // Pomme mordue (rouge foncé, marron, grisé)
            apple_bited_cell: {
                damaged: { r: [120, 180], g: [50, 100], b: [30, 80] },      // Marron/rouge foncé
                greyed: { r: [100, 160], g: [90, 150], b: [80, 140] },       // Gris
                shadowed: { r: [60, 120], g: [40, 90], b: [30, 70] }         // Sombre
            },
            // Cellule vide
            empty: {
                dark: { r: [0, 40], g: [0, 40], b: [0, 40] },
                light: { r: [220, 255], g: [220, 255], b: [220, 255] }
            }
        };
    }

    // ==========================================
    // SCAN PRINCIPAL
    // ==========================================

    scan() {
        const cells = [];

        // Stratégie 1: Scan du DOM
        const domCells = this.scanDOM();
        cells.push(...domCells);

        // Stratégie 2: Scan des Canvas
        const canvasCells = this.scanCanvas();
        cells.push(...canvasCells);

        // Stratégie 3: Scan des iframes
        const iframeCells = this.scanIframes();
        cells.push(...iframeCells);

        // Déduplication et vérification
        const uniqueCells = this.deduplicate(cells);
        const validatedCells = this.validateCells(uniqueCells);

        if (validatedCells.length > 0) {
            // Vérifier si l'état a changé
            const hash = this.hashCells(validatedCells);
            if (hash !== this.lastScanHash) {
                this.lastScanHash = hash;
                this.foundCells = validatedCells;
                
                if (this.onDetect) {
                    this.onDetect(validatedCells);
                }
                if (this.onDetectComplete) {
                    this.onDetectComplete();
                }
            }
        }

        return validatedCells;
    }

    forceScan() {
        this.lastScanHash = null;
        return this.scan();
    }

    scheduleScan() {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
        }
        this.scanTimer = setTimeout(() => {
            this.scan();
        }, this.engine.config.scanInterval || 200);
    }

    // ==========================================
    // SCAN DOM — CŒUR DE LA DÉTECTION
    // ==========================================

    scanDOM() {
        const cells = [];

        // Sélecteurs organisés par priorité
        const selectors = {
            // Sélecteurs spécifiques aux pommes
            apple_specific: [
                '[class*="apple_" i]', '[class*="apple-" i]', '[class*="apple" i]',
                '[id*="apple" i]', '[data-apple]', '[data-fruit]',
                '[class*="fruit" i]', '[class*="malus" i]', '[class*="bonus" i]',
                'div[class*="apple" i]', 'span[class*="apple" i]',
                'img[src*="apple" i]', 'img[alt*="apple" i]'
            ],
            // Sélecteurs de cellules de jeu
            game_cells: [
                '.game-cell', '.fortune-cell', '.grid-cell',
                '.cell', '.slot', '.item', '.tile',
                '[class*="cell" i]', '[class*="grid" i]',
                '[class*="tile" i]', '[class*="item" i]',
                '[class*="field" i]', '[class*="button" i]',
                '[class*="fortune" i]', '[class*="slot" i]',
                '[data-testid*="cell" i]', '[data-testid*="tile" i]',
                '[data-test*="cell" i]', '[data-test*="tile" i]'
            ],
            // Sélecteurs de grille
            grid_items: [
                '.grid-item', '.grid-cell', '.board-cell',
                '.table-cell', 'td.game', 'div.cell',
                '[role="gridcell"]', '[role="button"]',
                '[class*="board" i] [role="button"]',
                '[class*="game" i] [role="button"]',
                '[class*="fortune" i] [role="button"]'
            ],
            // Sélecteurs génériques
            generic: [
                'div[class*="win" i]', 'div[class*="lose" i]',
                'div[class*="good" i]', 'div[class*="bad" i]',
                'div[class*="success" i]', 'div[class*="fail" i]',
                'div[class*="hit" i]', 'div[class*="miss" i]',
                'div[class*="selected" i]', 'div[class*="choice" i]',
                'button[class*="win" i]', 'button[class*="lose" i]',
                '[aria-label*="apple" i]', '[aria-label*="win" i]', '[aria-label*="lose" i]'
            ],
            // Sélecteurs canvas/jeux
            canvas_elements: [
                'canvas', 'svg g', 'svg rect',
                'svg circle', 'svg image'
            ]
        };

        // Parcourir tous les sélecteurs
        for (const [category, selectorList] of Object.entries(selectors)) {
            for (const selector of selectorList) {
                try {
                    const elements = document.querySelectorAll(selector);
                    
                    for (const el of elements) {
                        if (!el || this.clickedCells.has(el)) continue;
                        
                        const rect = el.getBoundingClientRect();
                        
                        // Filtrer par taille
                        if (rect.width < this.thresholds.minCellSize || 
                            rect.height < this.thresholds.minCellSize ||
                            rect.width > this.thresholds.maxCellSize ||
                            rect.height > this.thresholds.maxCellSize) {
                            continue;
                        }

                        // Analyser l'élément
                        const analysis = this.analyzeElement(el, category);
                        
                        if (analysis.confidence >= this.thresholds.minConfidence) {
                            cells.push({
                                ...analysis,
                                elementRef: el,
                                rect: {
                                    left: rect.left,
                                    top: rect.top,
                                    width: rect.width,
                                    height: rect.height
                                },
                                timestamp: Date.now()
                            });
                        }
                    }
                } catch (e) {
                    // Sélecteur invalide, continuer
                }
            }
        }

        return cells;
    }

    // ==========================================
    // ANALYSE APPROFONDIE D'UN ÉLÉMENT
    // ==========================================

    analyzeElement(element, category) {
        // === COLLECTE DE TOUTES LES DONNÉES DISPONIBLES ===
        const data = {
            // Métadonnées
            tagName: element.tagName?.toLowerCase(),
            className: Array.from(element.classList || []),
            id: element.id || '',
            
            // Attributs
            dataAttrs: this.extractDataAttributes(element),
            allAttrs: this.extractAllAttributes(element),
            
            // Style
            computedStyle: window.getComputedStyle(element),
            inlineStyle: element.getAttribute('style') || '',
            
            // Contenu
            text: element.textContent?.trim() || '',
            innerHTML: element.innerHTML?.trim() || '',
            
            // Image
            src: element.getAttribute('src') || '',
            alt: element.getAttribute('alt') || '',
            
            // Relations DOM
            parentClasses: element.parentElement ? 
                Array.from(element.parentElement.classList || []) : [],
            parentId: element.parentElement?.id || '',
            siblings: this.getSiblingInfo(element),
            
            // Catégorie de sélecteur
            matchCategory: category
        };

        // === ANALYSE MULTI-CRITÈRE ===
        const scores = {
            // Score basé sur les classes CSS
            classScore: this.analyzeClasses(data.className, data.parentClasses),
            
            // Score basé sur le style computed
            styleScore: this.analyzeStyle(data.computedStyle),
            
            // Score basé sur les data-attributs
            attrScore: this.analyzeAttributes(data.dataAttrs, data.allAttrs),
            
            // Score basé sur le texte
            textScore: this.analyzeText(data.text, data.innerHTML),
            
            // Score basé sur les images
            imageScore: this.analyzeImage(data.src, data.alt),
            
            // Score basé sur le contexte DOM
            contextScore: this.analyzeContext(data)
        };

        // === DÉTERMINATION DU TYPE ===
        const { type, confidence } = this.determineType(scores);

        // === POSITION DANS LA GRILLE ===
        const gridPosition = this.detectGridPosition(element);

        return {
            type,
            confidence,
            scores,
            gridPosition,
            row: gridPosition.row,
            col: gridPosition.col,
            clickable: this.isClickable(element),
            revealed: this.isRevealed(element, data),
            platform: this.engine.platform,
            elementInfo: {
                tag: data.tagName,
                classes: data.className.slice(0, 5), // Top 5 classes
                id: data.id
            }
        };
    }

// ==========================================
    // ANALYSE DES CLASSES CSS (suite)
    // ==========================================

    analyzeClasses(classes, parentClasses) {
        const allClasses = [...classes, ...parentClasses.map(c => `parent-${c}`)];
        
        let appleScore = 0;
        let bittenScore = 0;
        let totalIndicators = 0;

        const appleIndicators = [
            { words: ['win', 'success', 'good', 'hit', 'correct', 'right', 'green', 'gold'], weight: 1 },
            { words: ['apple', 'fruit', 'full', 'whole', 'big', 'large'], weight: 0.8 },
            { words: ['selected', 'active', 'chosen', 'highlight'], weight: 0.6 },
            { words: ['cell-win', 'cell-good', 'cell-apple', 'grid-win'], weight: 1 },
            { words: ['opened', 'revealed', 'show', 'visible'], weight: 0.5 },
            { words: ['prize', 'jackpot', 'bonus', 'multiplier'], weight: 0.7 }
        ];

        const bittenIndicators = [
            { words: ['lose', 'loss', 'fail', 'bad', 'wrong', 'incorrect', 'miss', 'red'], weight: 1 },
            { words: ['bitten', 'bite', 'worm', 'rotten', 'damaged', 'broken'], weight: 1 },
            { words: ['empty', 'blank', 'none', 'null', 'zero'], weight: 0.7 },
            { words: ['cell-lose', 'cell-fail', 'cell-bad', 'grid-lose'], weight: 1 },
            { words: ['disabled', 'inactive', 'grey', 'gray', 'faded'], weight: 0.6 },
            { words: ['small', 'half', 'partial', 'mini'], weight: 0.5 }
        ];

        for (const cls of allClasses) {
            const lower = cls.toLowerCase();
            
            for (const indicator of appleIndicators) {
                if (indicator.words.some(w => lower.includes(w))) {
                    appleScore += indicator.weight;
                    totalIndicators++;
                }
            }
            
            for (const indicator of bittenIndicators) {
                if (indicator.words.some(w => lower.includes(w))) {
                    bittenScore += indicator.weight;
                    totalIndicators++;
                }
            }
        }

        // Score normalisé
        const total = appleScore + bittenScore;
        if (total === 0) return { appleScore: 0, bittenScore: 0, type: 'unknown', confidence: 0 };

        return {
            appleScore: appleScore / total,
            bittenScore: bittenScore / total,
            type: appleScore > bittenScore ? 'apple_cell' : 'apple_bited_cell',
            confidence: Math.min(1, total / 3)
        };
    }

    // ==========================================
    // ANALYSE DU STYLE COMPUTED
    // ==========================================

    analyzeStyle(style) {
        const bgColor = style.backgroundColor;
        const color = style.color;
        const opacity = parseFloat(style.opacity);
        const transform = style.transform;
        const filter = style.filter;
        const borderColor = style.borderColor;
        const boxShadow = style.boxShadow;
        
        let appleScore = 0;
        let bittenScore = 0;
        let evidence = [];

        // Analyser la couleur de fond
        if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
            const rgb = this.parseRGB(bgColor);
            if (rgb) {
                const { r, g, b } = rgb;
                
                // Rouge vif → pomme gagnante
                if (r > 180 && g < 120 && b < 100) {
                    appleScore += 2;
                    evidence.push('bg-red-bright');
                }
                // Vert → pomme gagnante aussi
                else if (r < 120 && g > 160 && b < 120) {
                    appleScore += 1.5;
                    evidence.push('bg-green');
                }
                // Doré/jaune → pomme gagnante (multiplicateur)
                else if (r > 200 && g > 180 && b < 100) {
                    appleScore += 1.5;
                    evidence.push('bg-gold');
                }
                // Marron/rouge foncé → pomme mordue
                else if (r > 100 && r < 180 && g > 50 && g < 120 && b > 30 && b < 90) {
                    bittenScore += 2;
                    evidence.push('bg-brown');
                }
                // Gris → pomme mordue ou vide
                else if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && r > 80 && r < 180) {
                    bittenScore += 1;
                    evidence.push('bg-grey');
                }
                // Très foncé → vide
                else if (r < 40 && g < 40 && b < 40) {
                    evidence.push('bg-dark');
                }
            }
        }

        // Opacité réduite → pomme mordue ou déjà utilisée
        if (opacity < 0.8 && opacity > 0) {
            bittenScore += 0.5;
            evidence.push('low-opacity');
        }

        // Filtre gris → pomme mordue
        if (filter && (filter.includes('grayscale') || filter.includes('grayScale'))) {
            bittenScore += 1;
            evidence.push('grayscale');
        }

        // Box shadow doré/vert → pomme gagnante
        if (boxShadow && boxShadow !== 'none') {
            if (boxShadow.includes('rgb(255, 215') || boxShadow.includes('gold') || boxShadow.includes('#ffd7')) {
                appleScore += 0.5;
                evidence.push('gold-shadow');
            }
            if (boxShadow.includes('rgb(0, 255') || boxShadow.includes('green') || boxShadow.includes('#00ff')) {
                appleScore += 0.5;
                evidence.push('green-shadow');
            }
        }

        const total = appleScore + bittenScore;
        const confidence = total > 0 ? Math.min(1, total / 3) : 0;

        return {
            appleScore: total > 0 ? appleScore / total : 0,
            bittenScore: total > 0 ? bittenScore / total : 0,
            type: appleScore > bittenScore ? 'apple_cell' : 'apple_bited_cell',
            confidence,
            evidence
        };
    }

    parseRGB(str) {
        if (!str) return null;
        const match = str.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (match) {
            return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
        }
        const match2 = str.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
        if (match2) {
            return { r: parseInt(match2[1]), g: parseInt(match2[2]), b: parseInt(match2[3]) };
        }
        return null;
    }

    // ==========================================
    // ANALYSE DES ATTRIBUTS
    // ==========================================

    analyzeAttributes(dataAttrs, allAttrs) {
        let appleScore = 0;
        let bittenScore = 0;

        // Data attributes spécifiques
        if (dataAttrs) {
            const val = dataAttrs.value || dataAttrs.state || dataAttrs.status || dataAttrs.type;
            if (val) {
                const lower = val.toLowerCase();
                if (['win', 'apple', 'good', 'full', 'success', 'hit', 'true'].includes(lower)) {
                    appleScore += 3;
                }
                if (['lose', 'bitten', 'bad', 'fail', 'miss', 'empty', 'false'].includes(lower)) {
                    bittenScore += 3;
                }
            }

            // Attributs numériques (multiplicateurs)
            for (const [key, value] of Object.entries(dataAttrs)) {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 1) {
                    if (num >= 2) appleScore += 1; // Multiplicateur élevé → bonne cellule
                }
            }
        }

        return {
            appleScore: Math.min(1, appleScore / 3),
            bittenScore: Math.min(1, bittenScore / 3),
            type: appleScore > bittenScore ? 'apple_cell' : 'apple_bited_cell',
            confidence: Math.min(1, Math.max(appleScore, bittenScore) / 3)
        };
    }

    // ==========================================
    // ANALYSE DU TEXTE
    // ==========================================

    analyzeText(text, innerHTML) {
        if (!text && !innerHTML) return { appleScore: 0, bittenScore: 0, type: 'empty', confidence: 0.5 };

        const content = (text + ' ' + innerHTML).toLowerCase();
        let appleScore = 0;
        let bittenScore = 0;

        // Symboles gagnants
        if (/[✓✔✅🍎🍏💰💎🎯🏆]/.test(content)) appleScore += 3;
        if (/[✗✘❌💀👎]/.test(content)) bittenScore += 3;

        // Textes
        if (/\b(win|won|apple|full|good|hit|success|prize|jackpot)\b/.test(content)) appleScore += 2;
        if (/\b(lose|lost|bitten|bad|miss|fail|empty|wrong)\b/.test(content)) bittenScore += 2;

        // Nombres (multiplicateurs)
        const nums = content.match(/\b(\d+(?:\.\d+)?)\s*[x×]\b/);
        if (nums) {
            const val = parseFloat(nums[1]);
            if (val >= 2) appleScore += 1.5;
            else if (val < 1) bittenScore += 0.5;
        }

        // Lettres simples (W = win, L = lose)
        if (/^W$/i.test(text.trim())) appleScore += 3;
        if (/^L$/i.test(text.trim())) bittenScore += 3;

        const total = appleScore + bittenScore;
        return {
            appleScore: total > 0 ? appleScore / total : 0,
            bittenScore: total > 0 ? bittenScore / total : 0,
            type: appleScore > bittenScore ? 'apple_cell' : appleScore === 0 && bittenScore === 0 ? 'empty' : 'apple_bited_cell',
            confidence: total > 0 ? Math.min(1, total / 4) : 0
        };
    }

    // ==========================================
    // ANALYSE D'IMAGE
    // ==========================================

    analyzeImage(src, alt) {
        if (!src && !alt) return { appleScore: 0, bittenScore: 0, type: 'unknown', confidence: 0 };

        const content = (src + ' ' + alt).toLowerCase();
        let appleScore = 0;
        let bittenScore = 0;

        if (content.includes('apple') || content.includes('fruit')) appleScore += 2;
        if (content.includes('win') || content.includes('full') || content.includes('whole')) appleScore += 1.5;
        if (content.includes('gold') || content.includes('shine')) appleScore += 1;

        if (content.includes('bitten') || content.includes('bite')) bittenScore += 2;
        if (content.includes('rotten') || content.includes('worm') || content.includes('damage')) bittenScore += 2;
        if (content.includes('empty') || content.includes('blank')) bittenScore += 0.5;

        const total = appleScore + bittenScore;
        return {
            appleScore: total > 0 ? appleScore / total : 0,
            bittenScore: total > 0 ? bittenScore / total : 0,
            type: appleScore > bittenScore ? 'apple_cell' : 'apple_bited_cell',
            confidence: total > 0 ? Math.min(1, total / 3) : 0
        };
    }

    // ==========================================
    // ANALYSE DU CONTEXTE DOM
    // ==========================================

    analyzeContext(data) {
        let appleScore = 0;
        let bittenScore = 0;

        // Vérifier les siblings
        for (const sibling of data.siblings) {
            if (sibling.includes('win') || sibling.includes('apple') || sibling.includes('good')) appleScore += 0.3;
            if (sibling.includes('lose') || sibling.includes('bitten') || sibling.includes('bad')) bittenScore += 0.3;
        }

        // Vérifier le parent
        if (data.parentClasses) {
            for (const cls of data.parentClasses) {
                const lower = cls.toLowerCase();
                if (lower.includes('grid') || lower.includes('board') || lower.includes('game')) {
                    // Contexte de jeu → plus de poids
                    appleScore += 0.2;
                    bittenScore += 0.2;
                }
                if (lower.includes('results') || lower.includes('revealed') || lower.includes('history')) {
                    // Contexte de résultats
                    bittenScore += 0.2;
                }
            }
        }

        return {
            appleScore: Math.min(1, appleScore),
            bittenScore: Math.min(1, bittenScore),
            confidence: Math.min(1, (appleScore + bittenScore) / 2)
        };
    }

    // ==========================================
    // DÉTERMINATION FINALE DU TYPE
    // ==========================================

    determineType(scores) {
        const weights = {
            classScore: 0.30,
            styleScore: 0.25,
            attrScore: 0.20,
            textScore: 0.15,
            imageScore: 0.05,
            contextScore: 0.05
        };

        let totalApple = 0;
        let totalBitten = 0;
        let totalWeight = 0;

        for (const [key, weight] of Object.entries(weights)) {
            const score = scores[key];
            if (score && score.confidence > 0) {
                totalApple += score.appleScore * weight;
                totalBitten += score.bittenScore * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight === 0) {
            return { type: 'unknown', confidence: 0 };
        }

        const appleFinal = totalApple / totalWeight;
        const bittenFinal = totalBitten / totalWeight;
        const confidence = Math.abs(appleFinal - bittenFinal) * (totalWeight / Object.values(weights).reduce((a, b) => a + b, 0));

        let type;
        if (confidence < 0.15) {
            type = 'unknown';
        } else if (appleFinal > bittenFinal) {
            type = 'apple_cell';
        } else {
            type = 'apple_bited_cell';
        }

        return {
            type,
            confidence: Math.min(1, confidence * 1.5), // Boost de confiance
            appleScore: appleFinal,
            bittenScore: bittenFinal
        };
    }

    // ==========================================
    // POSITION DANS LA GRILLE
    // ==========================================

    detectGridPosition(element) {
        // Méthode 1: Data attributes
        const row = element.getAttribute('data-row') || element.getAttribute('data-y') || element.getAttribute('data-line');
        const col = element.getAttribute('data-col') || element.getAttribute('data-x') || element.getAttribute('data-column');
        
        if (row !== null && col !== null) {
            return { row: parseInt(row), col: parseInt(col), method: 'data-attr' };
        }

        // Méthode 2: Position dans le parent
        const parent = element.parentElement;
        if (parent) {
            const children = Array.from(parent.children);
            const index = children.indexOf(element);
            
            if (index >= 0) {
                const cols = this.detectGridCols(parent);
                if (cols > 0) {
                    return {
                        row: Math.floor(index / cols),
                        col: index % cols,
                        method: 'index',
                        index
                    };
                }
            }
        }

        // Méthode 3: Position CSS (grid/flex)
        const style = window.getComputedStyle(element);
        const gridRow = style.gridRow;
        const gridCol = style.gridColumn;
        
        if (gridRow && gridCol && gridRow !== 'auto' && gridCol !== 'auto') {
            return {
                row: parseInt(gridRow) - 1,
                col: parseInt(gridCol) - 1,
                method: 'css-grid'
            };
        }

        // Méthode 4: Classe CSS avec numéro
        for (const cls of element.classList) {
            const match = cls.match(/[_-]?(\d+)[_-]?(\d+)?/);
            if (match) {
                return {
                    row: parseInt(match[1]),
                    col: match[2] ? parseInt(match[2]) : 0,
                    method: 'class-regex'
                };
            }
        }

        return { row: 0, col: 0, method: 'fallback' };
    }

    detectGridCols(parent) {
        const style = window.getComputedStyle(parent);
        const gridTemplate = style.gridTemplateColumns;
        
        if (gridTemplate && gridTemplate !== 'none') {
            return gridTemplate.split(' ').length;
        }

        // Si flex, estimer par la largeur des enfants
        const firstChild = parent.firstElementChild;
        if (firstChild) {
            const parentWidth = parent.getBoundingClientRect().width;
            const childWidth = firstChild.getBoundingClientRect().width;
            if (childWidth > 0) {
                return Math.round(parentWidth / childWidth);
            }
        }

        return 5; // Default 5x5
    }

// ==========================================
    // SCAN CANVAS
    // ==========================================

    scanCanvas() {
        const cells = [];
        const canvases = document.querySelectorAll('canvas');

        for (const canvas of canvases) {
            try {
                const ctx = canvas.getContext('2d');
                if (!ctx) continue;

                const width = canvas.width;
                const height = canvas.height;
                if (width === 0 || height === 0) continue;

                const imageData = ctx.getImageData(0, 0, width, height);
                const pixelData = imageData.data;

                // Détecter la grille dans le canvas
                const gridCells = this.detectCanvasGrid(pixelData, width, height);

                for (const cell of gridCells) {
                    const analysis = this.analyzeCanvasCell(cell);
                    if (analysis.confidence >= this.thresholds.minConfidence) {
                        cells.push({
                            ...analysis,
                            source: 'canvas',
                            canvasId: canvas.id || canvas.className || 'unknown',
                            rect: cell.rect,
                            timestamp: Date.now()
                        });
                    }
                }
            } catch (e) {
                // Canvas cross-origin ou corrompu
                if (this.engine.config.debug) {
                    console.warn('[Detector] Erreur canvas:', e.message);
                }
            }
        }

        return cells;
    }

    detectCanvasGrid(pixelData, width, height) {
        const cells = [];
        const gridSize = 5; // 5x5 pour Apple of Fortune
        const cellWidth = Math.floor(width / gridSize);
        const cellHeight = Math.floor(height / gridSize);

        for (let row = 0; row < gridSize; row++) {
            for (let col = 0; col < gridSize; col++) {
                const startX = col * cellWidth;
                const startY = row * cellHeight;
                const endX = Math.min(startX + cellWidth, width);
                const endY = Math.min(startY + cellHeight, height);

                // Analyser les pixels de cette cellule
                const centerX = Math.floor((startX + endX) / 2);
                const centerY = Math.floor((startY + endY) / 2);
                
                // Échantillonnage: centre + 4 coins
                const samples = [
                    this.getPixel(pixelData, width, centerX, centerY),
                    this.getPixel(pixelData, width, startX + 5, startY + 5),
                    this.getPixel(pixelData, width, endX - 5, endY - 5),
                    this.getPixel(pixelData, width, startX + 5, endY - 5),
                    this.getPixel(pixelData, width, endX - 5, startY + 5)
                ];

                cells.push({
                    row,
                    col,
                    samples,
                    rect: {
                        left: startX,
                        top: startY,
                        width: cellWidth,
                        height: cellHeight
                    },
                    pixelCount: (endX - startX) * (endY - startY)
                });
            }
        }

        return cells;
    }

    getPixel(data, width, x, y) {
        const idx = (y * width + x) * 4;
        if (idx >= 0 && idx < data.length - 3) {
            return {
                r: data[idx],
                g: data[idx + 1],
                b: data[idx + 2],
                a: data[idx + 3]
            };
        }
        return null;
    }

    analyzeCanvasCell(cell) {
        if (!cell.samples || cell.samples.length === 0) {
            return { type: 'unknown', confidence: 0 };
        }

        let appleVotes = 0;
        let bittenVotes = 0;
        let totalVotes = 0;

        for (const pixel of cell.samples) {
            if (!pixel) continue;
            totalVotes++;

            const { r, g, b } = pixel;

            // Vérifier chaque profil de couleur
            for (const [type, profiles] of Object.entries(this.appleColorProfiles)) {
                for (const [profileName, range] of Object.entries(profiles)) {
                    if (r >= range.r[0] && r <= range.r[1] &&
                        g >= range.g[0] && g <= range.g[1] &&
                        b >= range.b[0] && b <= range.b[1]) {
                        
                        if (type === 'apple_cell') appleVotes++;
                        else if (type === 'apple_bited_cell') bittenVotes++;
                        break;
                    }
                }
            }
        }

        if (totalVotes === 0) {
            return { type: 'unknown', confidence: 0, row: cell.row, col: cell.col };
        }

        const confidence = Math.abs(appleVotes - bittenVotes) / totalVotes;
        const type = appleVotes > bittenVotes ? 'apple_cell' : 'apple_bited_cell';

        return {
            type,
            confidence: Math.min(1, confidence),
            row: cell.row,
            col: cell.col,
            appleVotes,
            bittenVotes,
            totalVotes
        };
    }

    // ==========================================
    // SCAN IFRAMES
    // ==========================================

    scanIframes() {
        const cells = [];
        const iframes = document.querySelectorAll('iframe');

        for (const iframe of iframes) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!doc) continue;

                // Injecter temporairement le détecteur dans l'iframe
                const iframeDetector = new AppleDetector({
                    ...this.engine,
                    platform: this.detectIframePlatform(iframe.src)
                });

                // Scanner les éléments dans l'iframe
                const elements = doc.querySelectorAll('[class*="apple"], [class*="cell"], [class*="grid"], canvas');
                
                for (const el of elements) {
                    const rect = el.getBoundingClientRect();
                    const analysis = iframeDetector.analyzeElement(el, 'iframe');
                    
                    if (analysis.confidence >= this.thresholds.minConfidence) {
                        cells.push({
                            ...analysis,
                            source: 'iframe',
                            iframeSrc: iframe.src?.substring(0, 100),
                            rect: {
                                left: rect.left + iframe.getBoundingClientRect().left,
                                top: rect.top + iframe.getBoundingClientRect().top,
                                width: rect.width,
                                height: rect.height
                            },
                            timestamp: Date.now()
                        });
                    }
                }
            } catch (e) {
                // Cross-origin iframe
            }
        }

        return cells;
    }

    detectIframePlatform(src) {
        if (!src) return 'unknown';
        if (src.includes('1xbet')) return '1xbet';
        if (src.includes('melbet')) return 'melbet';
        if (src.includes('winwin')) return 'winwin';
        if (src.includes('megapari')) return 'megapari';
        if (src.includes('1xgame')) return '1xgame';
        return 'iframe';
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    extractDataAttributes(element) {
        const attrs = {};
        for (const attr of element.attributes) {
            if (attr.name.startsWith('data-')) {
                attrs[attr.name.replace('data-', '')] = attr.value;
            }
        }
        return attrs;
    }

    extractAllAttributes(element) {
        const attrs = {};
        for (const attr of element.attributes) {
            attrs[attr.name] = attr.value;
        }
        return attrs;
    }

    getSiblingInfo(element) {
        const siblings = [];
        let sibling = element.parentElement?.firstElementChild;
        while (sibling) {
            if (sibling !== element) {
                siblings.push(sibling.className || sibling.tagName);
            }
            sibling = sibling.nextElementSibling;
        }
        return siblings;
    }

    isClickable(element) {
        const tag = element.tagName?.toLowerCase();
        const role = element.getAttribute('role');
        const cursor = window.getComputedStyle(element).cursor;
        const onclick = element.getAttribute('onclick');
        const listener = element.getAttribute('ng-click') || element.getAttribute('v-on:click');

        return (
            tag === 'button' ||
            tag === 'a' ||
            tag === 'input' ||
            role === 'button' ||
            cursor === 'pointer' ||
            onclick !== null ||
            listener !== null ||
            element.classList.contains('clickable') ||
            element.classList.contains('selectable')
        );
    }

    isRevealed(element, data) {
        // Une cellule est révélée si on peut voir son état
        return (
            data.computedStyle?.opacity !== '0' &&
            data.computedStyle?.visibility !== 'hidden' &&
            data.computedStyle?.display !== 'none' &&
            element.getBoundingClientRect().width > 0 &&
            data.text.length > 0 &&
            data.className.some(c => 
                c.includes('revealed') || 
                c.includes('opened') || 
                c.includes('shown') ||
                c.includes('selected') ||
                c.includes('active')
            )
        );
    }

    handleUserClick(element) {
        // Marquer la cellule comme cliquée
        this.clickedCells.add(element);
        
        // Analyser rapidement après le clic
        setTimeout(() => {
            const analysis = this.analyzeElement(element, 'user-click');
            if (analysis.confidence >= this.thresholds.minConfidence) {
                analysis.clicked = true;
                this.revealedCells.set(element, analysis);
                
                if (this.onDetect) {
                    this.onDetect([analysis]);
                }
                if (this.onDetectComplete) {
                    this.onDetectComplete();
                }
            }
        }, 300); // Attendre l'animation
    }

    // ==========================================
    // DÉDUPLICATION ET VALIDATION
    // ==========================================

    deduplicate(cells) {
        const seen = new Set();
        return cells.filter(cell => {
            const key = `${cell.row}-${cell.col}-${cell.type}-${cell.source}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    validateCells(cells) {
        return cells.filter(cell => {
            // Vérifier les doublons par position
            const posKey = `${cell.row}-${cell.col}`;
            const existing = cells.filter(c => `${c.row}-${c.col}` === posKey);
            
            if (existing.length > 1) {
                // Garder celui avec la meilleure confiance
                return cell === existing.sort((a, b) => b.confidence - a.confidence)[0];
            }
            return true;
        });
    }

    hashCells(cells) {
        return cells
            .sort((a, b) => a.row - b.row || a.col - b.col)
            .map(c => `${c.row}:${c.col}:${c.type}:${c.confidence.toFixed(2)}`)
            .join('|');
    }

    reset() {
        this.foundCells = [];
        this.lastScanHash = null;
        this.clickedCells.clear();
        this.revealedCells.clear();
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }
    }
}

// Exporter
window.AppleDetector = AppleDetector;
    
