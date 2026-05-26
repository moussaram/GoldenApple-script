// core/predictor.js - Prédicteur de patterns Apple of Fortune
// Analyse les données historiques pour prédire:
// - Les cellules à forte probabilité de gain
// - Les patterns de répétition
// - Les phases à risque/rentables

class ApplePredictor {
    constructor(engine) {
        this.engine = engine;
        
        // Historique d'analyses
        this.analysisHistory = [];
        this.patternHistory = [];
        this.predictionHistory = [];
        
        // État interne
        this.lastPrediction = null;
        this.confidence = 0;
        this.patterns = [];
        this.runningStats = {
            totalRounds: 0,
            appleRatio: 0,
            bittenRatio: 0,
            currentStreak: 0,
            bestStreak: 0,
            worstStreak: 0,
            averageConfidence: 0
        };
        
        this.onPredict = null; // Callback

        // Configuration des patterns
        this.config = {
            minHistorySize: 3,       // Minimum d'historique pour prédire
            patternWindow: 10,       // Fenêtre d'analyse des patterns
            confidenceBoost: 0.1,    // Boost par pattern trouvé
            maxPredictions: 5,       // Maximum de prédictions par cycle
            decayRate: 0.95,         // Taux de dégradation des patterns anciens
            streakThreshold: 3       // Seuil pour considérer une streak
        };
    }

    // ==========================================
    // ALIMENTATION
    // ==========================================

    feedAnalysis(analysis) {
        if (!analysis) return;

        // Stocker l'analyse
        this.analysisHistory.push({
            ...analysis,
            storedAt: Date.now()
        });

        // Limiter la taille
        if (this.analysisHistory.length > 100) {
            this.analysisHistory.shift();
        }

        // Mettre à jour les stats
        this.updateRunningStats(analysis);

        // Détecter les patterns
        this.detectPatterns();

        // Générer une prédiction si assez de données
        if (this.analysisHistory.length >= this.config.minHistorySize) {
            const prediction = this.generatePrediction();
            
            if (prediction && prediction.confidence >= this.engine.config.confidenceThreshold) {
                this.lastPrediction = prediction;
                this.predictionHistory.push(prediction);
                
                // Limiter
                if (this.predictionHistory.length > 50) {
                    this.predictionHistory.shift();
                }

                // Callback
                if (this.onPredict) {
                    this.onPredict(prediction);
                }

                if (this.engine.config.debug) {
                    console.log(`[Predictor] Prédiction: ${prediction.recommendedCells?.length || 0} cellules recommandées (conf: ${(prediction.confidence * 100).toFixed(1)}%)`);
                }
            }
        }

        return this.lastPrediction;
    }

    // ==========================================
    // STATISTIQUES COURANTES
    // ==========================================

    updateRunningStats(analysis) {
        this.runningStats.totalRounds++;
        
        const stats = analysis.gridStats;
        if (stats) {
            // Ratio glissant
            this.runningStats.appleRatio = (
                this.runningStats.appleRatio * 0.7 + 
                (stats.appleRatio || 0) * 0.3
            );
            this.runningStats.bittenRatio = (
                this.runningStats.bittenRatio * 0.7 + 
                (stats.bittenRatio || 0) * 0.3
            );

            // Streak de pommes gagnantes
            if (stats.appleCount > stats.bittenCount) {
                this.runningStats.currentStreak = Math.max(0, this.runningStats.currentStreak) + 1;
                this.runningStats.bestStreak = Math.max(this.runningStats.bestStreak, this.runningStats.currentStreak);
            } else if (stats.bittenCount > stats.appleCount) {
                this.runningStats.currentStreak = Math.min(0, this.runningStats.currentStreak) - 1;
                this.runningStats.worstStreak = Math.min(this.runningStats.worstStreak, this.runningStats.currentStreak);
            }
        }

        // Confiance moyenne
        if (analysis.phaseMetrics) {
            this.runningStats.averageConfidence = (
                this.runningStats.averageConfidence * 0.9 + 
                (analysis.phaseMetrics.appleProbability || 0) * 0.1
            );
        }
    }

    // ==========================================
    // DÉTECTION DE PATTERNS
    // ==========================================

    detectPatterns() {
        if (this.analysisHistory.length < 2) return;

        const newPatterns = [];
        const recent = this.analysisHistory.slice(-this.config.patternWindow);

        // Pattern 1: Répétition de positions gagnantes
        const positionPattern = this.detectPositionPattern(recent);
        if (positionPattern) newPatterns.push(positionPattern);

        // Pattern 2: Séquences de phases
        const sequencePattern = this.detectPhaseSequence(recent);
        if (sequencePattern) newPatterns.push(sequencePattern);

        // Pattern 3: Distribution des pommes
        const distributionPattern = this.detectDistributionPattern(recent);
        if (distributionPattern) newPatterns.push(distributionPattern);

        // Pattern 4: Corrélation temporelle
        const temporalPattern = this.detectTemporalPattern(recent);
        if (temporalPattern) newPatterns.push(temporalPattern);

        // Pattern 5: Symétrie de grille
        const symmetryPattern = this.detectSymmetryPattern(recent);
        if (symmetryPattern) newPatterns.push(symmetryPattern);

        // Fusionner avec les patterns existants (avec decay)
        this.patterns = [
            ...this.patterns.map(p => ({
                ...p,
                confidence: p.confidence * this.config.decayRate,
                age: (p.age || 0) + 1
            })),
            ...newPatterns
        ].filter(p => p.confidence > 0.3); // Garder les patterns significatifs

        // Limiter
        if (this.patterns.length > 20) {
            this.patterns.sort((a, b) => b.confidence - a.confidence);
            this.patterns = this.patterns.slice(0, 20);
        }
    }

    // ==========================================
    // PATTERN 1: POSITIONS GAGNANTES RÉPÉTÉES
    // ==========================================

    detectPositionPattern(recent) {
        // Compter les occurrences de chaque position gagnante
        const positionCounts = new Map();

        for (const analysis of recent) {
            if (!analysis.appleCells) continue;
            
            for (const cell of analysis.appleCells) {
                const key = `${cell.row}-${cell.col}`;
                positionCounts.set(key, (positionCounts.get(key) || 0) + 1);
            }
        }

        // Trouver les positions qui reviennent le plus souvent
        const totalRounds = recent.length;
        const hotPositions = [];

        for (const [key, count] of positionCounts) {
            const ratio = count / totalRounds;
            if (ratio > 0.4) { // Présent dans plus de 40% des rounds
                const [row, col] = key.split('-').map(Number);
                hotPositions.push({
                    row,
                    col,
                    frequency: ratio,
                    occurrences: count,
                    total: totalRounds
                });
            }
        }

        if (hotPositions.length > 0) {
            return {
                type: 'hot_positions',
                name: 'Positions récurrentes',
                positions: hotPositions,
                confidence: Math.min(1, hotPositions.length * 0.15 + hotPositions[0].frequency * 0.5),
                description: `${hotPositions.length} positions gagnantes récurrentes détectées`,
                data: hotPositions
            };
        }

        return null;
    }

    // ==========================================
    // PATTERN 2: SÉQUENCES DE PHASES
    // ==========================================

    detectPhaseSequence(recent) {
        if (recent.length < 3) return null;

        // Analyser la progression des phases
        const phaseProgression = [];
        for (let i = 1; i < recent.length; i++) {
            const prev = recent[i - 1];
            const curr = recent[i];
            
            if (prev.phase !== undefined && curr.phase !== undefined) {
                const delta = curr.phase - prev.phase;
                phaseProgression.push(delta);
            }
        }

        // Chercher des patterns dans la progression
        if (phaseProgression.length > 2) {
            const uniqueValues = new Set(phaseProgression);
            
            if (uniqueValues.size === 1 && uniqueValues.has(1)) {
                // Progression linéaire: +1 à chaque fois
                const lastPhase = recent[recent.length - 1].phase;
                return {
                    type: 'linear_progression',
                    name: 'Progression linéaire',
                    nextPhase: lastPhase + 1,
                    confidence: 0.85,
                    description: 'Les phases progressent de manière linéaire (+1)',
                    data: { currentPhase: lastPhase, step: 1 }
                };
            }

            if (uniqueValues.size <= 2) {
                // Progression avec un pattern
                return {
                    type: 'cyclic_progression',
                    name: 'Progression cyclique',
                    confidence: 0.6,
                    description: 'Les phases suivent un cycle régulier',
                    data: { deltas: phaseProgression.slice(-5) }
                };
            }
        }

        return null;
    }

    // ==========================================
    // PATTERN 3: DISTRIBUTION DES POMMES
    // ==========================================

    detectDistributionPattern(recent) {
        if (recent.length < 3) return null;

        // Analyser la distribution des pommes dans la grille
        const distributions = [];

        for (const analysis of recent) {
            const stats = analysis.gridStats;
            if (stats) {
                distributions.push({
                    appleRatio: stats.appleRatio,
                    bittenRatio: stats.bittenRatio,
                    density: stats.density,
                    total: stats.total
                });
            }
        }

        if (distributions.length < 2) return null;

        // Vérifier si la distribution est stable
        const appleRatios = distributions.map(d => d.appleRatio);
        const avg = appleRatios.reduce((a, b) => a + b, 0) / appleRatios.length;
        const variance = appleRatios.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / appleRatios.length;
        const stdDev = Math.sqrt(variance);

        // Distribution stable → prédictible
        if (stdDev < 0.1 && avg > 0.3) {
            return {
                type: 'stable_distribution',
                name: 'Distribution stable',
                averageRatio: avg,
                stdDev,
                confidence: Math.min(1, 0.7 + (1 - stdDev * 5) * 0.3),
                description: `Distribution stable des pommes (moy: ${(avg * 100).toFixed(1)}%, écart: ${(stdDev * 100).toFixed(1)}%)`,
                data: { averageRatio: avg, stdDev, samples: distributions.length }
            };
        }

        // Distribution qui tend à augmenter
        if (distributions.length >= 3) {
            const recent3 = appleRatios.slice(-3);
            const trend = recent3[2] - recent3[0];
            if (trend > 0.05) {
                return {
                    type: 'increasing_distribution',
                    name: 'Distribution croissante',
                    trend: trend,
                    confidence: 0.6,
                    description: `Tendance à la hausse des pommes gagnantes (+${(trend * 100).toFixed(1)}%)`,
                    data: { trend, values: recent3 }
                };
            }
        }

        return null;
    }

    // ==========================================
    // PATTERN 4: CORRÉLATION TEMPORELLE
    // ==========================================

    detectTemporalPattern(recent) {
        if (recent.length < 4) return null;

        // Analyser le timing entre les analyses
        const intervals = [];
        for (let i = 1; i < recent.length; i++) {
            intervals.push(recent[i].timestamp - recent[i - 1].timestamp);
        }

        if (intervals.length < 3) return null;

        // Si les intervalles sont réguliers
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const maxInterval = Math.max(...intervals);
        const minInterval = Math.min(...intervals);
        const regularity = 1 - ((maxInterval - minInterval) / (avgInterval || 1));

        if (regularity > 0.7) {
            return {
                type: 'temporal_regularity',
                name: 'Régularité temporelle',
                regularity,
                averageInterval: avgInterval,
                confidence: 0.5 + regularity * 0.4,
                description: `Intervalles réguliers entre les phases (${(avgInterval / 1000).toFixed(1)}s en moyenne)`,
                data: { avgInterval, regularity, samples: intervals.length }
            };
        }

        return null;
    }

    // ==========================================
    // PATTERN 5: SYMÉTRIE DE GRILLE
    // ==========================================

    detectSymmetryPattern(recent) {
        if (recent.length < 2) return null;

        const last = recent[recent.length - 1];
        if (!last.appleCells || !last.bittenCells) return null;

        // Vérifier la symétrie horizontale
        const gridSize = 5; // 5x5
        const applePositions = new Set(last.appleCells.map(c => `${c.row}-${c.col}`));
        const bittenPositions = new Set(last.bittenCells.map(c => `${c.row}-${c.col}`));

        let symmetricApples = 0;
        let totalApples = applePositions.size;

        for (const pos of applePositions) {
            const [row, col] = pos.split('-').map(Number);
            const mirrorCol = gridSize - 1 - col;
            if (applePositions.has(`${row}-${mirrorCol}`) && mirrorCol !== col) {
                symmetricApples++;
            }
        }

        if (totalApples > 0 && symmetricApples / totalApples > 0.6) {
            return {
                type: 'grid_symmetry',
                name: 'Symétrie de grille',
                symmetryRatio: symmetricApples / totalApples,
                confidence: 0.6 + (symmetricApples / totalApples) * 0.3,
                description: `Grille symétrique: ${symmetricApples}/${totalApples} pommes en miroir`,
                data: { symmetricCount: symmetricApples, totalCount: totalApples, axis: 'horizontal' }
            };
        }

        return null;
    }

    // ==========================================
    // GÉNÉRATION DE PRÉDICTION
    // ==========================================

    generatePrediction() {
        if (this.analysisHistory.length < this.config.minHistorySize) {
            return null;
        }

        const lastAnalysis = this.analysisHistory[this.analysisHistory.length - 1];
        const recentAnalyses = this.analysisHistory.slice(-this.config.patternWindow);

        // Calculer la confiance globale
        let baseConfidence = this.runningStats.averageConfidence;
        let patternBoost = 0;
        let reasoning = [];

        // Boost par patterns actifs
        for (const pattern of this.patterns) {
            if (pattern.confidence > 0.5) {
                patternBoost += pattern.confidence * this.config.confidenceBoost;
                reasoning.push(pattern.description);
            }
        }

        // Ajustement par streak
        if (Math.abs(this.runningStats.currentStreak) >= this.config.streakThreshold) {
            if (this.runningStats.currentStreak > 0) {
                patternBoost += 0.15; // En streak gagnant
                reasoning.push(`Streak gagnante: ${this.runningStats.currentStreak} rounds`);
            } else {
                patternBoost -= 0.1; // En streak perdant
                reasoning.push(`Streak perdante: ${Math.abs(this.runningStats.currentStreak)} rounds`);
            }
        }

        const totalConfidence = Math.min(1, baseConfidence + patternBoost);
        
        // Si la confiance est trop faible, ne pas prédire
        if (totalConfidence < this.engine.config.confidenceThreshold) {
            return null;
        }

        // === RECOMMANDER DES CELLULES ===

        // 1. À partir des patterns de positions chaudes
        const hotPositions = this.patterns.find(p => p.type === 'hot_positions');
        const recommendedCells = [];

        if (hotPositions) {
            for (const pos of hotPositions.positions.slice(0, this.config.maxPredictions)) {
                recommendedCells.push({
                    row: pos.row,
                    col: pos.col,
                    confidence: pos.frequency,
                    source: 'position_pattern',
                    reason: `Position gagnante récurrente (${(pos.frequency * 100).toFixed(0)}%)`
                });
            }
        }

        // 2. À partir de la symétrie
        const symmetryPattern = this.patterns.find(p => p.type === 'grid_symmetry');
        if (symmetryPattern && lastAnalysis.bittenCells) {
            // Si une cellule est mordue, sa symétrique a plus de chances d'être gagnante
            for (const cell of lastAnalysis.bittenCells) {
                const mirrorCol = 4 - cell.col; // 5x5 grid
                const exists = recommendedCells.find(c => c.row === cell.row && c.col === mirrorCol);
                if (!exists) {
                    recommendedCells.push({
                        row: cell.row,
                        col: mirrorCol,
                        confidence: symmetryPattern.confidence * 0.7,
                        source: 'symmetry',
                        reason: `Symétrique d'une cellule perdante`
                    });
                }
            }
        }

        // 3. À partir de la distribution
        const distPattern = this.patterns.find(p => p.type === 'stable_distribution' || p.type === 'increasing_distribution');
        if (distPattern && distPattern.type === 'increasing_distribution') {
            // Si la tendance est haussière, recommander plus de cellules
            // (Les cellules non encore révélées avec forte probabilité)
            const unrevealed = this.findUnrevealedCells(lastAnalysis);
            for (const cell of unrevealed.slice(0, 3)) {
                if (!recommendedCells.find(c => c.row === cell.row && c.col === cell.col)) {
                    recommendedCells.push({
                        row: cell.row,
                        col: cell.col,
                        confidence: 0.55,
                        source: 'distribution_trend',
                        reason: 'Tendance haussière des gains'
                    });
                }
            }
        }

        // 4. Phases recommandées
        const phaseRecommendation = this.recommendPhases();

        // Trier par confiance décroissante et limiter
        recommendedCells.sort((a, b) => b.confidence - a.confidence);
        const topCells = recommendedCells.slice(0, this.config.maxPredictions);

        // === CONSTRUIRE LA PRÉDICTION ===
        const prediction = {
            timestamp: Date.now(),
            phase: lastAnalysis.phase,
            confidence: totalConfidence,
            
            // Cellules recommandées
            recommendedCells: topCells.length > 0 ? topCells : null,
            
            // Phases
            phaseRecommendation,
            
            // Métriques globales
            stats: {
                ...this.runningStats,
                activePatterns: this.patterns.filter(p => p.confidence > 0.5).length,
                totalPatterns: this.patterns.length
            },
            
            // Patterns actifs
            activePatterns: this.patterns
                .filter(p => p.confidence > 0.5)
                .map(p => ({
                    type: p.type,
                    name: p.name,
                    confidence: p.confidence,
                    description: p.description
                })),
            
            // Raisonnement
            reasoning: reasoning.length > 0 ? reasoning : ['Prédiction basée sur les tendances générales'],
            
            // Risque estimé
            risk: this.estimateRisk(totalConfidence),
            
            // Durée de validité
            validUntil: Date.now() + 5000 // 5 secondes
        };

        // Log
        if (this.engine.config.debug) {
            console.log(`[Predictor] Prédiction prête | Conf: ${(totalConfidence * 100).toFixed(1)}% | Cells: ${topCells.length} | Patterns: ${this.patterns.filter(p => p.confidence > 0.5).length}`);
        }

        return prediction;
    }

    // ==========================================
    // RECHERCHE DE CELLULES NON RÉVÉLÉES
    // ==========================================

    findUnrevealedCells(analysis) {
        if (!analysis || !analysis.appleCells || !analysis.bittenCells) return [];

        const revealed = new Set([
            ...(analysis.appleCells || []).map(c => `${c.row}-${c.col}`),
            ...(analysis.bittenCells || []).map(c => `${c.row}-${c.col}`)
        ]);

        const gridSize = 5;
        const unrevealed = [];

        for (let row = 0; row < gridSize; row++) {
            for (let col = 0; col < gridSize; col++) {
                if (!revealed.has(`${row}-${col}`)) {
                    unrevealed.push({ row, col });
                }
            }
        }

        return unrevealed;
    }

    // ==========================================
    // RECOMMANDATION DE PHASES
    // ==========================================

    recommendPhases() {
        if (this.analysisHistory.length < 3) return null;

        const last = this.analysisHistory[this.analysisHistory.length - 1];
        const currentPhase = last.phase;

        // Estimer les phases rentables basées sur l'historique
        const phasePerformance = new Map();

        for (const analysis of this.analysisHistory) {
            if (!analysis.gridStats) continue;
            
            const phase = analysis.phase;
            if (!phasePerformance.has(phase)) {
                phasePerformance.set(phase, {
                    totalRounds: 0,
                    totalApples: 0,
                    totalBitten: 0
                });
            }

            const stats = phasePerformance.get(phase);
            stats.totalRounds++;
            stats.totalApples += analysis.gridStats.appleCount || 0;
            stats.totalBitten += analysis.gridStats.bittenCount || 0;
        }

        const recommendations = [];
        for (const [phase, stats] of phasePerformance) {
            if (stats.totalRounds < 2) continue;
            
            const ratio = stats.totalApples / (stats.totalApples + stats.totalBitten || 1);
            recommendations.push({
                phase,
                ratio,
                rounds: stats.totalRounds,
                apples: stats.totalApples,
                bitten: stats.totalBitten,
                confidence: ratio * (1 - 1 / (stats.totalRounds + 1))
            });
        }

        recommendations.sort((a, b) => b.confidence - a.confidence);

        const next = currentPhase + 1;
        const nextPhaseStats = phasePerformance.get(next);
        const nextPhaseConfidence = nextPhaseStats 
            ? nextPhaseStats.totalApples / (nextPhaseStats.totalApples + nextPhaseStats.totalBitten || 1)
            : 0.5;

        return {
            currentPhase,
            nextPhase,
            nextPhaseConfidence,
            bestPhase: recommendations[0] || null,
            topPhases: recommendations.slice(0, 3),
            recommendation: nextPhaseConfidence > 0.6 ? 'favorable' : 'risky'
        };
    }

    // ==========================================
    // ESTIMATION DU RISQUE
    // ==========================================

    estimateRisk(confidence) {
        // Calculer le risque basé sur:
        // - La confiance de la prédiction
        // - La streak actuelle
        // - Le nombre de patterns actifs
        // - La stabilité de la distribution

        let risk = 1 - confidence;

        // Ajustement par streak
        if (Math.abs(this.runningStats.currentStreak) >= 3) {
            if (this.runningStats.currentStreak > 0) {
                risk *= 0.8; // Moins risqué en streak gagnante
            } else {
                risk *= 1.3; // Plus risqué en streak perdante (loi des séries)
            }
        }

        // Ajustement par patterns
        const activePatterns = this.patterns.filter(p => p.confidence > 0.6).length;
        if (activePatterns >= 2) {
            risk *= 0.7; // Patterns multiples = plus fiable
        } else if (activePatterns === 0) {
            risk *= 1.2; // Aucun pattern = plus risqué
        }

        return {
            level: risk < 0.3 ? 'low' : risk < 0.6 ? 'medium' : 'high',
            score: Math.min(1, Math.max(0, risk)),
            factors: {
                confidence,
                streak: this.runningStats.currentStreak,
                activePatterns,
                historySize: this.analysisHistory.length
            }
        };
    }

    // ==========================================
    // UTILITAIRES
    // ==========================================

    getLastPrediction() {
        return this.lastPrediction;
    }

    getPatterns() {
        return this.patterns;
    }

    getStats() {
        return { ...this.runningStats };
    }

    getHistory() {
        return this.predictionHistory;
    }

    reset() {
        this.analysisHistory = [];
        this.patternHistory = [];
        this.predictionHistory = [];
        this.lastPrediction = null;
        this.confidence = 0;
        this.patterns = [];
        this.runningStats = {
            totalRounds: 0,
            appleRatio: 0,
            bittenRatio: 0,
            currentStreak: 0,
            bestStreak: 0,
            worstStreak: 0,
            averageConfidence: 0
        };
    }
}

// Exporter
window.ApplePredictor = ApplePredictor;
