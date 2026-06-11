// src/routes/sessions.js
const express = require('express');
const db = require('../models');
const router = express.Router();

// Özet liste — samples/profile response'a girmez (büyük). pauseCount
// events'ten sayılır.
router.get('/sessions', async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
		const offset = parseInt(req.query.offset, 10) || 0;
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

router.get('/sessions/:id', async (req, res) => {
	try {
		const row = await db.sessions.findByPk(req.params.id);
		if (!row) {
			return res
				.status(404)
				.json({ success: false, errorMessage: 'Session not found' });
		}
		res.json({ success: true, data: row });
	} catch (error) {
		res.status(500).json({ success: false, errorMessage: error.message });
	}
});

module.exports = router;
