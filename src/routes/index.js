const express = require('express');
const db = require('../models');
const dayjs = require('dayjs');
const fs = require('fs');
const router = express.Router();

router.use([require('./sensors.js')]);

// Get session chart
router.get('/getChart', async (req, res) => {
	fs.readFile('chart.png', (err, data) => {
		if (err) {
			res.status(500).json({ error: err.message });
		} else {
			res.contentType('image/png');
			res.send(data);
		}
	});
});

// Test endpoint to create sample session profile
router.get('/testChart', async (req, res) => {
	try {
		// Create a sample profile for testing
		const sampleProfile = [
			[10, 0, 'air'], // 10 minutes descent to 0 bar
			[5, 2.4, 'air'], // 5 minutes descent to 2.4 bar (equivalent to 33 feet)
			[20, 2.4, 'o2'], // 20 minutes at depth with oxygen
			[15, 2.4, 'air'], // 15 minutes at depth with air
			[10, 2.4, 'o2'], // 10 minutes at depth with oxygen
			[20, 0, 'air'], // 20 minutes ascent to surface
		];

		// Initialize global.sessionStatus if it doesn't exist
		if (!global.sessionStatus) {
			global.sessionStatus = {};
		}

		// Set the sample profile to global sessionStatus
		global.sessionStatus.profile = sampleProfile;

		res.json({
			message:
				'Sample profile created successfully. You can now call /getChart to see the graph.',
			profile: sampleProfile,
		});
	} catch (error) {
		console.error('Test chart error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Yeni hasta ekle
router.post('/patients', async (req, res) => {
	try {
		const { fullName, birthDate, gender } = req.body;
		const patient = await db.patients.create({
			fullName,
			birthDate,
			gender,
		});
		res.status(201).json(patient);
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Hasta listesini getir
router.get('/patients', async (req, res) => {
	try {
		const patients = await db.patients.findAll();
		res.json(patients);
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

module.exports = router;
