// src/routes/sessions.js
const express = require('express');
const db = require('../models');
const router = express.Router();

// Özet liste — samples/profile response'a girmez (büyük). pauseCount
// events'ten sayılır.
router.get('/sessions', async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
		const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
		const rows = await db.sessions.findAll({
			attributes: [
				'id',
				'startTime',
				'endTime',
				'status',
				'targetPressure',
				'duration',
				'speed',
				'events',
			],
			order: [['startTime', 'DESC']],
			limit,
			offset,
		});
		const data = rows.map((r) => {
			const json = r.toJSON();
			const events = r.events || [];
			json.pauseCount = events.filter((e) => e.type === 'pause').length;
			delete json.events;
			return json;
		});
		res.json({ success: true, data });
	} catch (error) {
		res.status(500).json({ success: false, errorMessage: error.message });
	}
});

// İstatistik: toplam seans sayısı + toplam çalışma süresi (saniye).
// NOT: '/sessions/:id'den ÖNCE tanımlı olmalı, yoksa 'stats' :id'ye yakalanır.
router.get('/sessions/stats', async (req, res) => {
	try {
		const [row] = await db.sequelize.query(
			`SELECT
				(SELECT COUNT(*) FROM Sessions) AS totalSessions,
				COALESCE(SUM((julianday(endTime) - julianday(startTime)) * 86400), 0)
					AS totalSeconds
			 FROM Sessions WHERE endTime IS NOT NULL`,
			{ type: db.Sequelize.QueryTypes.SELECT },
		);
		res.json({
			success: true,
			data: {
				totalSessions: row.totalSessions || 0,
				totalSeconds: Math.round(row.totalSeconds || 0),
			},
		});
	} catch (error) {
		res.status(500).json({ success: false, errorMessage: error.message });
	}
});

router.get('/sessions/:id', async (req, res) => {
	try {
		const row = await db.sessions.findByPk(req.params.id);
		if (!row) {
			return res
				.status(404)
				.json({ success: false, errorMessage: 'Session not found' });
		}
		res.json({ success: true, data: row.toJSON() });
	} catch (error) {
		res.status(500).json({ success: false, errorMessage: error.message });
	}
});

module.exports = router;
