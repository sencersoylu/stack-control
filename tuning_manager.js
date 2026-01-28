/**
 * Tuning Manager - PID Parametre Oto-Ayar Sistemi
 *
 * Veri toplama ve kural bazli parametre ayarlama modulu
 *
 * Kullanim:
 * 1. tuningManager.startCollection() - Veri toplamaya basla
 * 2. Her saniye tuningManager.collectDataPoint() cagrilir
 * 3. tuningManager.stopAndAnalyze() - Analiz et ve oneri olustur
 * 4. tuningManager.applyRecommendations() - Onerileri uygula
 */

class TuningManager {
	constructor() {
		this.isCollecting = false;
		this.currentSession = null;
		this.dataPoints = [];
		this.db = null;

		// Parametre sinirlari (guvenlik icin)
		this.paramLimits = {
			comp_offset: { min: 5, max: 35 },
			comp_gain: { min: 1, max: 25 },
			comp_depth: { min: 30, max: 250 },
			decomp_offset: { min: 5, max: 35 },
			decomp_gain: { min: 1, max: 20 },
			decomp_depth: { min: 30, max: 250 },
		};

		// Ayar kurallari esik degerleri
		this.thresholds = {
			overshootWarning: 3,      // % - uyari seviyesi
			overshootCritical: 8,     // % - kritik seviye
			undershootWarning: 5,     // % - uyari seviyesi
			undershootCritical: 10,   // % - kritik seviye
			settlingTimeMax: 60,      // saniye - maksimum oturma suresi
			oscillationCount: 3,      // salinimdan once izin verilen gecis sayisi
			steadyStateError: 0.5,    // FSW - kabul edilebilir sabit durum hatasi
		};
	}

	/**
	 * Veritabani referansini ayarla
	 */
	setDatabase(db) {
		this.db = db;
	}

	/**
	 * Veri toplamaya basla
	 */
	async startCollection(sessionParams) {
		if (this.isCollecting) {
			return { success: false, message: 'Veri toplama zaten aktif' };
		}

		this.isCollecting = true;
		this.dataPoints = [];

		// Mevcut parametreleri kaydet
		const currentParams = {
			comp_offset: global.sessionStatus?.comp_offset || 18,
			comp_gain: global.sessionStatus?.comp_gain || 8,
			comp_depth: global.sessionStatus?.comp_depth || 100,
			decomp_offset: global.sessionStatus?.decomp_offset || 14,
			decomp_gain: global.sessionStatus?.decomp_gain || 7,
			decomp_depth: global.sessionStatus?.decomp_depth || 100,
		};

		// Veritabanina kaydet
		if (this.db && this.db.tuning) {
			try {
				this.currentSession = await this.db.tuning.create({
					sessionStartTime: new Date(),
					status: 'collecting',
					targetDepth: sessionParams?.setDerinlik || 0,
					targetDuration: sessionParams?.toplamSure || 0,
					usedCompOffset: currentParams.comp_offset,
					usedCompGain: currentParams.comp_gain,
					usedCompDepth: currentParams.comp_depth,
					usedDecompOffset: currentParams.decomp_offset,
					usedDecompGain: currentParams.decomp_gain,
					usedDecompDepth: currentParams.decomp_depth,
					collectedData: [],
				});
			} catch (err) {
				console.error('Tuning session olusturulamadi:', err);
			}
		}

		console.log('Tuning: Veri toplama basladi');
		return {
			success: true,
			message: 'Veri toplama basladi',
			sessionId: this.currentSession?.id
		};
	}

	/**
	 * Her saniye cagrilacak veri toplama fonksiyonu
	 */
	collectDataPoint(data) {
		if (!this.isCollecting) return;

		const dataPoint = {
			timestamp: Date.now(),
			zaman: data.zaman || 0,
			hedef: data.hedef || 0,           // Hedef basinc (FSW)
			olcum: data.main_fsw || 0,        // Gercek basinc (FSW)
			fark: (data.hedef || 0) - (data.main_fsw || 0),
			grafikdurum: data.grafikdurum,    // 0: inis, 1: cikis, 2: duz
			compValve: data.pcontrol || 0,    // Kompresor vana acisi
			decompValve: data.decompControl || 0, // Dekompresyon vana acisi
			pressure: data.pressure || 0,     // Bar cinsinden basinc
		};

		this.dataPoints.push(dataPoint);

		// Her 60 saniyede bir veritabanina kaydet (performans icin)
		if (this.dataPoints.length % 60 === 0 && this.currentSession) {
			this.saveDataToDb();
		}
	}

	/**
	 * Veriyi veritabanina kaydet
	 */
	async saveDataToDb() {
		if (!this.currentSession || !this.db) return;

		try {
			await this.currentSession.update({
				collectedData: this.dataPoints,
			});
		} catch (err) {
			console.error('Tuning verisi kaydedilemedi:', err);
		}
	}

	/**
	 * Veri toplamayi durdur ve analiz et
	 */
	async stopAndAnalyze() {
		if (!this.isCollecting) {
			return { success: false, message: 'Veri toplama aktif degil' };
		}

		this.isCollecting = false;
		console.log('Tuning: Veri toplama durduruldu, analiz basliyor...');
		console.log(`Tuning: Toplam ${this.dataPoints.length} veri noktasi toplandi`);

		// Son verileri kaydet
		await this.saveDataToDb();

		// Analiz yap
		const analysis = this.analyzeData();

		// Kural bazli onerileri olustur
		const recommendations = this.generateRecommendations(analysis);

		// Veritabanini guncelle
		if (this.currentSession) {
			try {
				await this.currentSession.update({
					sessionEndTime: new Date(),
					status: 'completed',
					analysisResults: analysis,
					suggestedParams: recommendations,
				});
			} catch (err) {
				console.error('Tuning analiz sonuclari kaydedilemedi:', err);
			}
		}

		return {
			success: true,
			message: 'Analiz tamamlandi',
			analysis,
			recommendations,
			dataPointCount: this.dataPoints.length,
		};
	}

	/**
	 * Toplanan veriyi analiz et
	 */
	analyzeData() {
		if (this.dataPoints.length < 10) {
			return { error: 'Yeterli veri yok (min 10 nokta gerekli)' };
		}

		const analysis = {
			// Genel metrikler
			totalDataPoints: this.dataPoints.length,
			durationSeconds: this.dataPoints.length,

			// Faz bazli analiz
			phases: {
				rising: this.analyzePhase(1),    // Yukselis
				flat: this.analyzePhase(2),      // Duz (tedavi)
				descending: this.analyzePhase(0) // Inis
			},

			// Genel performans metrikleri
			overall: this.calculateOverallMetrics(),
		};

		return analysis;
	}

	/**
	 * Belirli bir fazi analiz et
	 */
	analyzePhase(grafikdurum) {
		const phaseData = this.dataPoints.filter(d => d.grafikdurum === grafikdurum);

		if (phaseData.length < 5) {
			return {
				dataPoints: phaseData.length,
				insufficient: true
			};
		}

		const errors = phaseData.map(d => d.fark);
		const absErrors = errors.map(e => Math.abs(e));

		// Overshoot analizi (hedefin ustune cikma)
		const overshoots = phaseData.filter(d => d.fark < -0.5); // Negatif fark = overshoot
		const maxOvershoot = Math.min(...errors); // En buyuk overshoot (en negatif)

		// Undershoot analizi (hedefe ulasamama)
		const undershoots = phaseData.filter(d => d.fark > 0.5);
		const maxUndershoot = Math.max(...errors);

		// Oscillation (salinım) analizi
		let oscillationCount = 0;
		for (let i = 1; i < errors.length; i++) {
			if (Math.sign(errors[i]) !== Math.sign(errors[i-1]) &&
				Math.abs(errors[i]) > 0.3 && Math.abs(errors[i-1]) > 0.3) {
				oscillationCount++;
			}
		}

		// Settling time (oturma suresi) - hedefe yaklasma suresi
		let settlingTime = null;
		const targetReached = phaseData.findIndex(d => Math.abs(d.fark) < 0.5);
		if (targetReached > 0) {
			settlingTime = targetReached;
		}

		// Steady state error (sabit durum hatasi)
		const lastPoints = phaseData.slice(-10);
		const steadyStateError = lastPoints.length > 0
			? lastPoints.reduce((sum, d) => sum + Math.abs(d.fark), 0) / lastPoints.length
			: null;

		// Rise time (yukselme suresi) - sadece yukselis fazinda
		let riseTime = null;
		if (grafikdurum === 1 && phaseData.length > 0) {
			const targetPressure = phaseData[phaseData.length - 1].hedef;
			const riseIndex = phaseData.findIndex(d => d.olcum >= targetPressure * 0.9);
			if (riseIndex > 0) {
				riseTime = riseIndex;
			}
		}

		return {
			dataPoints: phaseData.length,
			insufficient: false,

			// Hata metrikleri
			meanAbsoluteError: absErrors.reduce((a, b) => a + b, 0) / absErrors.length,
			maxError: Math.max(...absErrors),

			// Overshoot
			overshootCount: overshoots.length,
			maxOvershootFSW: Math.abs(maxOvershoot),
			overshootPercent: phaseData[0]?.hedef > 0
				? (Math.abs(maxOvershoot) / phaseData[0].hedef) * 100
				: 0,

			// Undershoot
			undershootCount: undershoots.length,
			maxUndershootFSW: maxUndershoot,
			undershootPercent: phaseData[0]?.hedef > 0
				? (maxUndershoot / phaseData[0].hedef) * 100
				: 0,

			// Dinamik ozellikler
			oscillationCount,
			settlingTime,
			riseTime,
			steadyStateError,
		};
	}

	/**
	 * Genel performans metriklerini hesapla
	 */
	calculateOverallMetrics() {
		const errors = this.dataPoints.map(d => d.fark);
		const absErrors = errors.map(e => Math.abs(e));

		// RMS Error
		const rmsError = Math.sqrt(
			errors.reduce((sum, e) => sum + e * e, 0) / errors.length
		);

		// Toplam overshoot/undershoot suresi
		const overshootTime = this.dataPoints.filter(d => d.fark < -0.5).length;
		const undershootTime = this.dataPoints.filter(d => d.fark > 0.5).length;
		const onTargetTime = this.dataPoints.filter(d => Math.abs(d.fark) <= 0.5).length;

		return {
			meanAbsoluteError: absErrors.reduce((a, b) => a + b, 0) / absErrors.length,
			rmsError,
			maxError: Math.max(...absErrors),
			overshootTimePercent: (overshootTime / this.dataPoints.length) * 100,
			undershootTimePercent: (undershootTime / this.dataPoints.length) * 100,
			onTargetTimePercent: (onTargetTime / this.dataPoints.length) * 100,
		};
	}

	/**
	 * Kural bazli parametre onerileri olustur
	 */
	generateRecommendations(analysis) {
		if (analysis.error) {
			return { error: analysis.error };
		}

		const currentParams = {
			comp_offset: this.currentSession?.usedCompOffset || global.sessionStatus?.comp_offset || 18,
			comp_gain: this.currentSession?.usedCompGain || global.sessionStatus?.comp_gain || 8,
			comp_depth: this.currentSession?.usedCompDepth || global.sessionStatus?.comp_depth || 100,
			decomp_offset: this.currentSession?.usedDecompOffset || global.sessionStatus?.decomp_offset || 14,
			decomp_gain: this.currentSession?.usedDecompGain || global.sessionStatus?.decomp_gain || 7,
			decomp_depth: this.currentSession?.usedDecompDepth || global.sessionStatus?.decomp_depth || 100,
		};

		const newParams = { ...currentParams };
		const adjustments = [];
		const reasons = [];

		// ========== YUKSELIS FAZI KURALLARI ==========
		const rising = analysis.phases.rising;
		if (rising && !rising.insufficient) {

			// Kural 1: Overshoot varsa gain azalt
			if (rising.overshootPercent > this.thresholds.overshootCritical) {
				const reduction = 0.15; // %15 azalt
				newParams.comp_gain = this.clampParam(
					'comp_gain',
					currentParams.comp_gain * (1 - reduction)
				);
				adjustments.push({
					param: 'comp_gain',
					from: currentParams.comp_gain,
					to: newParams.comp_gain,
					reason: `Yukseliste kritik overshoot (${rising.overshootPercent.toFixed(1)}%)`
				});
			} else if (rising.overshootPercent > this.thresholds.overshootWarning) {
				const reduction = 0.08;
				newParams.comp_gain = this.clampParam(
					'comp_gain',
					currentParams.comp_gain * (1 - reduction)
				);
				adjustments.push({
					param: 'comp_gain',
					from: currentParams.comp_gain,
					to: newParams.comp_gain,
					reason: `Yukseliste overshoot (${rising.overshootPercent.toFixed(1)}%)`
				});
			}

			// Kural 2: Undershoot varsa (yeterince hizli yukselemiyor) gain artir
			if (rising.undershootPercent > this.thresholds.undershootCritical) {
				const increase = 0.12;
				newParams.comp_gain = this.clampParam(
					'comp_gain',
					currentParams.comp_gain * (1 + increase)
				);
				adjustments.push({
					param: 'comp_gain',
					from: currentParams.comp_gain,
					to: newParams.comp_gain,
					reason: `Yukseliste kritik undershoot (${rising.undershootPercent.toFixed(1)}%)`
				});
			}

			// Kural 3: Oscillation varsa gain azalt, offset artir
			if (rising.oscillationCount > this.thresholds.oscillationCount) {
				newParams.comp_gain = this.clampParam(
					'comp_gain',
					currentParams.comp_gain * 0.9
				);
				newParams.comp_offset = this.clampParam(
					'comp_offset',
					currentParams.comp_offset * 1.05
				);
				adjustments.push({
					param: 'comp_gain + comp_offset',
					from: `gain:${currentParams.comp_gain}, offset:${currentParams.comp_offset}`,
					to: `gain:${newParams.comp_gain.toFixed(1)}, offset:${newParams.comp_offset.toFixed(1)}`,
					reason: `Yukseliste oscillation (${rising.oscillationCount} kez)`
				});
			}

			// Kural 4: Rise time cok uzunsa offset artir
			if (rising.riseTime && rising.riseTime > this.thresholds.settlingTimeMax) {
				newParams.comp_offset = this.clampParam(
					'comp_offset',
					currentParams.comp_offset * 1.1
				);
				adjustments.push({
					param: 'comp_offset',
					from: currentParams.comp_offset,
					to: newParams.comp_offset,
					reason: `Yukselis suresi cok uzun (${rising.riseTime}s)`
				});
			}
		}

		// ========== DUZ FAZ KURALLARI ==========
		const flat = analysis.phases.flat;
		if (flat && !flat.insufficient) {

			// Kural 5: Steady state error yuksekse depth ayarla
			if (flat.steadyStateError > this.thresholds.steadyStateError) {
				// Pozitif hata (undershoot) = comp_depth azalt
				// Negatif hata (overshoot) = comp_depth artir
				const avgError = this.dataPoints
					.filter(d => d.grafikdurum === 2)
					.reduce((sum, d) => sum + d.fark, 0) / flat.dataPoints;

				if (avgError > 0.3) {
					newParams.comp_depth = this.clampParam(
						'comp_depth',
						currentParams.comp_depth * 0.95
					);
					adjustments.push({
						param: 'comp_depth',
						from: currentParams.comp_depth,
						to: newParams.comp_depth,
						reason: `Duz fazda steady-state undershoot (${flat.steadyStateError.toFixed(2)} FSW)`
					});
				} else if (avgError < -0.3) {
					newParams.comp_depth = this.clampParam(
						'comp_depth',
						currentParams.comp_depth * 1.05
					);
					adjustments.push({
						param: 'comp_depth',
						from: currentParams.comp_depth,
						to: newParams.comp_depth,
						reason: `Duz fazda steady-state overshoot (${flat.steadyStateError.toFixed(2)} FSW)`
					});
				}
			}

			// Kural 6: Duz fazda oscillation
			if (flat.oscillationCount > 2) {
				newParams.comp_gain = this.clampParam(
					'comp_gain',
					newParams.comp_gain * 0.92
				);
				newParams.decomp_gain = this.clampParam(
					'decomp_gain',
					currentParams.decomp_gain * 0.92
				);
				adjustments.push({
					param: 'comp_gain + decomp_gain',
					from: `comp:${currentParams.comp_gain}, decomp:${currentParams.decomp_gain}`,
					to: `comp:${newParams.comp_gain.toFixed(1)}, decomp:${newParams.decomp_gain.toFixed(1)}`,
					reason: `Duz fazda oscillation (${flat.oscillationCount} kez)`
				});
			}
		}

		// ========== INIS FAZI KURALLARI ==========
		const descending = analysis.phases.descending;
		if (descending && !descending.insufficient) {

			// Kural 7: Iniste overshoot (cok hizli inis)
			if (descending.overshootPercent > this.thresholds.overshootWarning) {
				newParams.decomp_gain = this.clampParam(
					'decomp_gain',
					currentParams.decomp_gain * 0.9
				);
				adjustments.push({
					param: 'decomp_gain',
					from: currentParams.decomp_gain,
					to: newParams.decomp_gain,
					reason: `Iniste cok hizli dusus (${descending.overshootPercent.toFixed(1)}%)`
				});
			}

			// Kural 8: Iniste undershoot (cok yavas inis)
			if (descending.undershootPercent > this.thresholds.undershootWarning) {
				newParams.decomp_gain = this.clampParam(
					'decomp_gain',
					currentParams.decomp_gain * 1.1
				);
				newParams.decomp_offset = this.clampParam(
					'decomp_offset',
					currentParams.decomp_offset * 1.05
				);
				adjustments.push({
					param: 'decomp_gain + decomp_offset',
					from: `gain:${currentParams.decomp_gain}, offset:${currentParams.decomp_offset}`,
					to: `gain:${newParams.decomp_gain.toFixed(1)}, offset:${newParams.decomp_offset.toFixed(1)}`,
					reason: `Iniste yavas dusus (${descending.undershootPercent.toFixed(1)}%)`
				});
			}
		}

		// ========== PERFORMANS OZETI ==========
		const overall = analysis.overall;
		let performanceScore = 100;

		// Puan dusurme
		performanceScore -= overall.overshootTimePercent * 0.5;
		performanceScore -= overall.undershootTimePercent * 0.3;
		performanceScore -= overall.rmsError * 2;
		performanceScore = Math.max(0, Math.min(100, performanceScore));

		return {
			currentParams,
			suggestedParams: newParams,
			adjustments,
			performanceScore: performanceScore.toFixed(1),
			hasChanges: adjustments.length > 0,
			summary: this.generateSummary(adjustments, performanceScore),
		};
	}

	/**
	 * Parametre degerini sinirlar icinde tut
	 */
	clampParam(paramName, value) {
		const limits = this.paramLimits[paramName];
		if (!limits) return value;
		return Math.round(Math.max(limits.min, Math.min(limits.max, value)) * 10) / 10;
	}

	/**
	 * Ozet metin olustur
	 */
	generateSummary(adjustments, score) {
		if (adjustments.length === 0) {
			return `Performans skoru: ${score}/100. Parametre degisikligi onerilmiyor, sistem iyi calisıyor.`;
		}

		const changes = adjustments.map(a => a.param).join(', ');
		return `Performans skoru: ${score}/100. ${adjustments.length} parametre degisikligi oneriliyor: ${changes}`;
	}

	/**
	 * Onerileri global sessionStatus'a uygula
	 */
	async applyRecommendations(recommendations) {
		if (!recommendations || !recommendations.suggestedParams) {
			return { success: false, message: 'Gecerli oneri bulunamadi' };
		}

		const params = recommendations.suggestedParams;

		// Global sessionStatus'a uygula
		if (global.sessionStatus) {
			global.sessionStatus.comp_offset = params.comp_offset;
			global.sessionStatus.comp_gain = params.comp_gain;
			global.sessionStatus.comp_depth = params.comp_depth;
			global.sessionStatus.decomp_offset = params.decomp_offset;
			global.sessionStatus.decomp_gain = params.decomp_gain;
			global.sessionStatus.decomp_depth = params.decomp_depth;
		}

		// Veritabanindaki config'i guncelle
		if (this.db && this.db.config) {
			try {
				await this.db.config.update({
					compOffset: params.comp_offset,
					compGain: params.comp_gain,
					compDepth: params.comp_depth,
					decompOffset: params.decomp_offset,
					decompGain: params.decomp_gain,
					decompDepth: params.decomp_depth,
				}, { where: { id: 1 } });
			} catch (err) {
				console.error('Config guncellenemedi:', err);
			}
		}

		// Tuning session'i onayla
		if (this.currentSession) {
			try {
				await this.currentSession.update({
					approved: true,
					approvedAt: new Date(),
				});
			} catch (err) {
				console.error('Tuning session onaylanamadi:', err);
			}
		}

		console.log('Tuning: Yeni parametreler uygulandi', params);

		return {
			success: true,
			message: 'Parametreler basariyla uygulandi',
			appliedParams: params
		};
	}

	/**
	 * Mevcut durumu getir
	 */
	getStatus() {
		return {
			isCollecting: this.isCollecting,
			dataPointCount: this.dataPoints.length,
			sessionId: this.currentSession?.id,
			currentParams: {
				comp_offset: global.sessionStatus?.comp_offset,
				comp_gain: global.sessionStatus?.comp_gain,
				comp_depth: global.sessionStatus?.comp_depth,
				decomp_offset: global.sessionStatus?.decomp_offset,
				decomp_gain: global.sessionStatus?.decomp_gain,
				decomp_depth: global.sessionStatus?.decomp_depth,
			}
		};
	}

	/**
	 * Gecmis tuning session'larini getir
	 */
	async getHistory(limit = 10) {
		if (!this.db || !this.db.tuning) {
			return [];
		}

		try {
			const sessions = await this.db.tuning.findAll({
				order: [['sessionStartTime', 'DESC']],
				limit,
				attributes: ['id', 'sessionStartTime', 'sessionEndTime', 'status',
					'targetDepth', 'targetDuration', 'approved', 'suggestedParams', 'analysisResults']
			});
			return sessions;
		} catch (err) {
			console.error('Tuning gecmisi alinamadi:', err);
			return [];
		}
	}
}

// Singleton instance
const tuningManager = new TuningManager();

module.exports = { TuningManager, tuningManager };
