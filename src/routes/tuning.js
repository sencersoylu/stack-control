const express = require('express');
const router = express.Router();
const { tuningManager } = require('../../tuning_manager');

/**
 * GET /tuning/status
 * Tuning sisteminin mevcut durumunu getir
 */
router.get('/tuning/status', (req, res) => {
	try {
		const status = tuningManager.getStatus();
		res.json({
			success: true,
			data: status
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * POST /tuning/start
 * Veri toplamaya basla
 * Body: { setDerinlik, toplamSure } (opsiyonel)
 */
router.post('/tuning/start', async (req, res) => {
	try {
		// Seans parametrelerini al (varsa)
		const sessionParams = {
			setDerinlik: req.body.setDerinlik || global.sessionStatus?.setDerinlik || 0,
			toplamSure: req.body.toplamSure || global.sessionStatus?.toplamSure || 0,
		};

		const result = await tuningManager.startCollection(sessionParams);
		res.json(result);
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * POST /tuning/stop
 * Veri toplamayi durdur ve analiz et
 */
router.post('/tuning/stop', async (req, res) => {
	try {
		const result = await tuningManager.stopAndAnalyze();
		res.json(result);
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * POST /tuning/apply
 * Onerilen parametreleri uygula
 * Body: { recommendations } (stopAndAnalyze'dan donen deger)
 */
router.post('/tuning/apply', async (req, res) => {
	try {
		const { recommendations } = req.body;

		if (!recommendations) {
			return res.status(400).json({
				success: false,
				error: 'recommendations objesi gerekli'
			});
		}

		const result = await tuningManager.applyRecommendations(recommendations);
		res.json(result);
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * GET /tuning/history
 * Gecmis tuning session'larini getir
 * Query: ?limit=10
 */
router.get('/tuning/history', async (req, res) => {
	try {
		const limit = parseInt(req.query.limit) || 10;
		const history = await tuningManager.getHistory(limit);
		res.json({
			success: true,
			data: history
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * GET /tuning/session/:id
 * Belirli bir tuning session'in detaylarini getir
 */
router.get('/tuning/session/:id', async (req, res) => {
	try {
		const db = require('../models');
		const session = await db.tuning.findByPk(req.params.id);

		if (!session) {
			return res.status(404).json({
				success: false,
				error: 'Session bulunamadi'
			});
		}

		res.json({
			success: true,
			data: session
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * GET /tuning/current-params
 * Mevcut PID parametrelerini getir
 */
router.get('/tuning/current-params', (req, res) => {
	try {
		const params = {
			comp_offset: global.sessionStatus?.comp_offset || 18,
			comp_gain: global.sessionStatus?.comp_gain || 8,
			comp_depth: global.sessionStatus?.comp_depth || 100,
			decomp_offset: global.sessionStatus?.decomp_offset || 14,
			decomp_gain: global.sessionStatus?.decomp_gain || 7,
			decomp_depth: global.sessionStatus?.decomp_depth || 100,
			minimumvalve: global.sessionStatus?.minimumvalve || 20,
		};

		res.json({
			success: true,
			data: params
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

/**
 * PUT /tuning/params
 * PID parametrelerini manuel olarak guncelle
 * Body: { comp_offset, comp_gain, comp_depth, decomp_offset, decomp_gain, decomp_depth }
 */
router.put('/tuning/params', async (req, res) => {
	try {
		const {
			comp_offset,
			comp_gain,
			comp_depth,
			decomp_offset,
			decomp_gain,
			decomp_depth
		} = req.body;

		// Global sessionStatus'a uygula
		if (global.sessionStatus) {
			if (comp_offset !== undefined) global.sessionStatus.comp_offset = comp_offset;
			if (comp_gain !== undefined) global.sessionStatus.comp_gain = comp_gain;
			if (comp_depth !== undefined) global.sessionStatus.comp_depth = comp_depth;
			if (decomp_offset !== undefined) global.sessionStatus.decomp_offset = decomp_offset;
			if (decomp_gain !== undefined) global.sessionStatus.decomp_gain = decomp_gain;
			if (decomp_depth !== undefined) global.sessionStatus.decomp_depth = decomp_depth;
		}

		// Veritabanini guncelle
		const db = require('../models');
		await db.config.update({
			compOffset: comp_offset,
			compGain: comp_gain,
			compDepth: comp_depth,
			decompOffset: decomp_offset,
			decompGain: decomp_gain,
			decompDepth: decomp_depth,
		}, { where: { id: 1 } });

		res.json({
			success: true,
			message: 'Parametreler guncellendi',
			data: {
				comp_offset: global.sessionStatus?.comp_offset,
				comp_gain: global.sessionStatus?.comp_gain,
				comp_depth: global.sessionStatus?.comp_depth,
				decomp_offset: global.sessionStatus?.decomp_offset,
				decomp_gain: global.sessionStatus?.decomp_gain,
				decomp_depth: global.sessionStatus?.decomp_depth,
			}
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message
		});
	}
});

module.exports = router;
