const express = require('express');
const db = require('../models');
const dayjs = require('dayjs');
const fs = require('fs');
const router = express.Router();

router.use([require('./sensors.js')]);
router.use([require('./config.js')]);

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
